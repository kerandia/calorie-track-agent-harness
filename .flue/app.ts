import { flue, observe, registerProvider } from "@flue/runtime/app";
import { Hono } from "hono";
import { Redis } from "@upstash/redis";
import {
  downloadFile,
  downloadPhotoBase64,
  sendMessage,
  sendTyping,
  sendVoice,
  type TgUpdate,
} from "./lib/telegramApi.js";
import { createLoginToken } from "./lib/loginToken.js";
import { cleanForSpeech, synthesize } from "./lib/fishAudio.js";
import { transcribeVoice } from "./lib/stt.js";
import { MAIN_MODEL_ID } from "./lib/models.js";
import {
  acquireTurnLock,
  inboxLength,
  peekInbox,
  pushInbox,
  releaseTurnLock,
  removeInboxItem,
  trimInbox,
  type InboxItem,
} from "./lib/inbox.js";

// Structured run telemetry → Cloud Run Logs Explorer (queryable JSON lines).
// This is the observability layer; no external platform needed at this scale.
observe((event) => {
  if (event.type !== "run_end") return;
  const e = event as unknown as {
    runId?: string;
    isError?: boolean;
    durationMs?: number;
  };
  console.log(
    JSON.stringify({
      evt: "agent_run_end",
      runId: e.runId,
      isError: e.isError ?? false,
      durationMs: e.durationMs,
    }),
  );
});

/**
 * Runtime provider/model config (build-time config lives in flue.config.ts).
 *
 * We register the OpenRouter prefix explicitly because:
 *  1. Some models we use (e.g. nvidia/nemotron-3-ultra-550b-a55b:free) are
 *     newer than pi-ai's bundled catalog, so Flue's resolver rejects them
 *     with "Unknown model" unless we declare them here.
 *  2. It lets us cap maxTokens. Flue otherwise reserves up to 32k output
 *     tokens per call, which OpenRouter pre-authorizes against the balance —
 *     wasteful, and a source of 402s when credits run low. Our replies are
 *     tiny; 8k is plenty for reply + tool calls.
 *
 * Caveat: a registered prefix WINS over pi-ai's catalog for ALL models under
 * it, so cost telemetry reads 0 and the reasoning flag is off for catalog
 * models (e.g. deepseek) routed this way. Fine while on a free model. When
 * switching back to paid deepseek and you want cost tracking, either remove
 * this registration (deepseek resolves natively) or add it to `models` with
 * accurate metadata.
 */
registerProvider("openrouter", {
  api: "openai-completions",
  baseUrl: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY,
  contextWindow: 131072,
  maxTokens: 8000,
  models: {
    "nvidia/nemotron-3-ultra-550b-a55b:free": {
      contextWindow: 131072,
      maxTokens: 8000,
    },
    "deepseek/deepseek-v4-pro": {
      contextWindow: 1048576,
      maxTokens: 8000,
    },
  },
});

/**
 * Nebius Token Factory — OpenAI-compatible inference endpoint.
 * Base URL and auth verified from docs.tokenfactory.nebius.com.
 * Reference a model as `nebius/<model-id>` in the agent's init({ model }).
 */
registerProvider("nebius", {
  api: "openai-completions",
  baseUrl: "https://api.tokenfactory.nebius.com/v1",
  apiKey: process.env.NEBIUS_API_KEY,
  contextWindow: 262144,
  maxTokens: 8000,
  models: {
    [MAIN_MODEL_ID]: {
      contextWindow: 1048576,
      maxTokens: 8000,
    },
    "Qwen/Qwen3-30B-A3B-Instruct-2507": {
      contextWindow: 262144,
      maxTokens: 8000,
    },
    "deepseek-ai/DeepSeek-V4-Pro": {
      contextWindow: 163840,
      maxTokens: 8000,
    },
  },
});

// ── Telegram ingestion pipeline (scale-to-zero) ────────────────────────────
//
// Telegram → POST /tg/webhook   fast ack (<1s): verify secret, dedupe, append
//                               the update to the tenant's Redis inbox, ping
//                               QStash
// QStash   → POST /tg/process   drains that tenant's inbox IN ORDER and
//                               coalesces a burst (a photo album, "here you
//                               go" + four pics, three rapid texts) into ONE
//                               agent turn; replies via Telegram sendMessage
//
// Why the queue hop at all: Telegram retries slow webhooks (duplicate turns),
// and Cloud Run's request-based billing only grants CPU inside a request — so
// the long turn must run in its own request. QStash provides that + retries.
//
// Why an inbox instead of one job per update: v1 published every update as its
// own QStash job and answered 429 while a turn was in flight so QStash would
// redeliver. QStash backs off as e^(2.5·n) seconds — 12s, 2.5min, 30min, 6h —
// so a five-photo album came back minutes-to-hours late, out of order, and
// sometimes never (retries exhausted → DLQ). It also meant five isolated turns,
// five "that's a freezer, not a plate" replies, and a model that never saw the
// photos side by side. The inbox keeps per-tenant order, never 429s, and lets
// one turn see the whole burst.

let _redis: Redis | null = null;
const redis = (): Redis => {
  if (!_redis) _redis = Redis.fromEnv();
  return _redis;
};

const env = (name: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} not set`);
  return v;
};

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

// Budget: Cloud Run's request timeout is 600s. One drain request may handle
// several batches; it stops STARTING new ones after DRAIN_DEADLINE_MS and hands
// the remainder to a fresh request, so lock TTL > deadline + one agent turn.
const LOCK_TTL_S = 570;
const DRAIN_DEADLINE_MS = 240_000;
const AGENT_TIMEOUT_MS = 300_000;

// Burst settling: wait until the newest inbox item is this old before acting,
// so an album (Telegram delivers each photo as its own update, ~0.2-1s apart)
// or a "text, then photos" sequence lands in a single turn. The webhook →
// QStash → process hop already takes ~1-3s, so this rarely adds real latency.
const SETTLE_MS = 1200;
const ALBUM_SETTLE_MS = 2500;
const MAX_SETTLE_WAIT_MS = 6000;

// Vision cost/latency cap per turn; extras are acknowledged, not analyzed.
const MAX_IMAGES_PER_TURN = 6;

const app = new Hono();

// The Flue agent routes (/agents/*) become publicly reachable once Cloud Run
// allows unauthenticated ingress — gate them behind an internal secret. The
// /tg/process handler self-fetches with this header.
app.use("/agents/*", async (c, next) => {
  if (c.req.header("x-internal-secret") !== env("INTERNAL_API_SECRET")) {
    return c.json({ error: "forbidden" }, 403);
  }
  await next();
});

/** Ask QStash to run /tg/process for this tenant. Cheap if a drain is already running. */
async function publishProcess(tenantId: string, chatId: number): Promise<boolean> {
  const res = await fetch(
    `https://qstash.upstash.io/v2/publish/${env("SERVICE_URL")}/tg/process`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env("QSTASH_TOKEN")}`,
        "Content-Type": "application/json",
        "Upstash-Forward-x-process-secret": env("INTERNAL_API_SECRET"),
        "Upstash-Retries": "3",
      },
      body: JSON.stringify({ tenantId, chatId }),
    },
  );
  if (!res.ok) {
    console.error(
      `[tg] QStash publish failed ${res.status}: ${await res.text().catch(() => "")}`,
    );
  }
  return res.ok;
}

app.post("/tg/webhook", async (c) => {
  if (
    c.req.header("x-telegram-bot-api-secret-token") !==
    env("TELEGRAM_WEBHOOK_SECRET")
  ) {
    return c.json({ error: "forbidden" }, 403);
  }

  const update = (await c.req.json().catch(() => null)) as TgUpdate | null;
  const msg = update?.message;
  // Handle plain user messages with text, a photo, or a voice note.
  if (
    !update ||
    !msg?.chat?.id ||
    !msg.from?.id ||
    (!msg.text && !msg.photo && !msg.voice)
  ) {
    return c.json({ ok: true });
  }

  // Dedupe: Telegram redelivers updates if it thinks the webhook failed.
  const dedupeKey = `tg:update:${update.update_id}`;
  const fresh = await redis().set(dedupeKey, "1", { nx: true, ex: 3600 });
  if (fresh !== "OK") return c.json({ ok: true });

  const tenantId = String(msg.from.id);
  const item: InboxItem = {
    update_id: update.update_id,
    received_at: Date.now(),
    message: msg,
  };
  await pushInbox(tenantId, item);

  if (!(await publishProcess(tenantId, msg.chat.id))) {
    // Undo both so Telegram's redelivery gets a clean second attempt.
    await removeInboxItem(tenantId, item).catch(() => {});
    await redis().del(dedupeKey).catch(() => {});
    return c.json({ error: "enqueue failed" }, 500);
  }
  return c.json({ ok: true });
});

/** Peek the inbox, waiting briefly while a burst is still arriving. */
async function collectBatch(tenantId: string): Promise<InboxItem[]> {
  const started = Date.now();
  for (;;) {
    const items = await peekInbox(tenantId);
    if (items.length === 0) return items;
    const last = items[items.length - 1]!;
    const settle = last.message.media_group_id ? ALBUM_SETTLE_MS : SETTLE_MS;
    const wait = last.received_at + settle - Date.now();
    if (wait <= 0 || Date.now() - started > MAX_SETTLE_WAIT_MS) return items;
    await sleep(Math.min(wait, 1500));
  }
}

app.post("/tg/process", async (c) => {
  if (c.req.header("x-process-secret") !== env("INTERNAL_API_SECRET")) {
    return c.json({ error: "forbidden" }, 403);
  }
  const body = (await c.req.json().catch(() => null)) as {
    tenantId?: string;
    chatId?: number;
  } | null;
  if (!body?.tenantId || !body.chatId) return c.json({ ok: true });
  const { tenantId, chatId } = body;
  const started = Date.now();

  for (;;) {
    if (!(await acquireTurnLock(tenantId, LOCK_TTL_S))) {
      // Another request is draining this tenant. It re-checks the inbox after
      // releasing the lock, so nothing we appended can be stranded.
      return c.json({ ok: true, deferred: true });
    }

    let continueLater = false;
    const typing = setInterval(() => void sendTyping(chatId), 4000);
    try {
      for (;;) {
        if (Date.now() - started > DRAIN_DEADLINE_MS) {
          continueLater = true;
          break;
        }
        const batch = await collectBatch(tenantId);
        if (batch.length === 0) break;
        void sendTyping(chatId);
        await handleBatch(chatId, tenantId, batch);
        await trimInbox(tenantId, batch.length);
      }
    } finally {
      clearInterval(typing);
      await releaseTurnLock(tenantId).catch(() => {});
    }

    if (continueLater) {
      // Hand the rest to a fresh request rather than tripping Cloud Run's timeout.
      await publishProcess(tenantId, chatId);
      return c.json({ ok: true, continued: true });
    }
    if ((await inboxLength(tenantId)) === 0) return c.json({ ok: true });
    // Something landed between our last empty peek and the lock release: go again.
  }
});

async function sendLoginLink(chatId: number, tenantId: string): Promise<void> {
  try {
    const token = await createLoginToken(tenantId);
    const dash = process.env.DASHBOARD_URL ?? "http://localhost:3100";
    await sendMessage(
      chatId,
      `Here's your dashboard login link (valid 10 minutes, one-time):\n${dash}/login/confirm?token=${token}`,
    );
  } catch (err) {
    console.error("[tg] login token failed:", err);
    await sendMessage(chatId, "Couldn't generate a login link right now. Try again in a sec.");
  }
}

const isLoginCommand = (text: string | undefined): boolean => {
  const cmd = (text ?? "").trim().toLowerCase();
  return cmd === "/login" || cmd === "/dashboard" || cmd === "/web";
};

/** Turn one burst of updates into one agent turn, and deliver the reply. */
async function handleBatch(
  chatId: number,
  tenantId: string,
  items: InboxItem[],
): Promise<void> {
  try {
    // /login-style commands are answered directly; they never need the agent.
    const turnItems: InboxItem[] = [];
    for (const it of items) {
      if (isLoginCommand(it.message.text)) await sendLoginLink(chatId, tenantId);
      else turnItems.push(it);
    }
    if (turnItems.length === 0) return;

    const texts: string[] = [];
    let wasVoice = false;
    for (const it of turnItems) {
      const m = it.message;
      if (m.voice) {
        const bytes = await downloadFile(m.voice.file_id);
        if (!bytes) {
          await sendMessage(chatId, "couldn't grab that voice note — try again?");
          continue;
        }
        try {
          const spoken = await transcribeVoice(bytes, "ogg");
          if (spoken) {
            texts.push(spoken);
            wasVoice = true;
          } else {
            await sendMessage(chatId, "heard mostly silence there — try again?");
          }
        } catch (err) {
          console.error("[tg] asr failed:", err);
          await sendMessage(chatId, "couldn't make out that voice note — mind typing it?");
        }
        continue;
      }
      const t = (m.text ?? m.caption ?? "").trim();
      if (t) texts.push(t);
    }

    // Photos: largest size of each, downloaded in parallel, capped per turn.
    const photoItems = turnItems.filter((it) => it.message.photo?.length);
    const analyzed = photoItems.slice(0, MAX_IMAGES_PER_TURN);
    const photosDropped = photoItems.length - analyzed.length;
    const downloads = await Promise.all(
      analyzed.map((it) => {
        const largest = it.message.photo![it.message.photo!.length - 1]!;
        return downloadPhotoBase64(largest.file_id);
      }),
    );
    const images = downloads.filter(
      (d): d is { base64: string; mimeType: string } => d !== null,
    );
    if (images.length < analyzed.length) {
      console.warn(
        `[tg] ${analyzed.length - images.length} of ${analyzed.length} photo downloads failed`,
      );
    }

    const text = texts.join("\n");
    if (!text && images.length === 0) {
      if (analyzed.length > 0) {
        await sendMessage(chatId, "couldn't read that image — try again?");
      }
      return;
    }

    const note = [
      images.length ? `[+${images.length} image${images.length === 1 ? "" : "s"}]` : "",
      wasVoice ? "[voice]" : "",
      turnItems.length > 1 ? `[burst of ${turnItems.length}]` : "",
    ]
      .filter(Boolean)
      .join(" ");
    console.log(`[${tenantId}] ${note} ${text || "(no caption)"}`);

    const port = process.env.PORT ?? "8080";
    const res = await fetch(
      `http://127.0.0.1:${port}/agents/chat/${turnItems[0]!.update_id}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-internal-secret": env("INTERNAL_API_SECRET"),
        },
        body: JSON.stringify({
          tenantId,
          text,
          images,
          voice: wasVoice,
          photosDropped: photosDropped > 0 ? photosDropped : undefined,
        }),
        signal: AbortSignal.timeout(AGENT_TIMEOUT_MS),
      },
    );

    if (!res.ok) {
      console.error(`[tg] agent ${res.status}: ${await res.text().catch(() => "")}`);
      await sendMessage(chatId, "the model just hiccuped on me — try again in a moment.");
      return; // don't retry LLM failures — user was told
    }
    const data = (await res.json()) as { result?: { reply?: string } };
    const reply = data.result?.reply;
    const runId = res.headers.get("x-flue-run-id") ?? "?";
    if (!reply) {
      console.error(`[tg] missing result.reply (run ${runId})`);
      await sendMessage(chatId, "(no reply)");
      return;
    }
    console.log(`[${tenantId}] <- (run ${runId}) ${reply.slice(0, 200)}`);

    // Poke mechanic: blank-line-separated thoughts become separate bubbles.
    const parts = reply
      .split(/\n{2,}/)
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 3);
    for (let i = 0; i < Math.max(parts.length, 1); i++) {
      await sendMessage(chatId, parts[i] ?? reply);
      if (i < parts.length - 1) await sleep(450);
    }

    // Spoken in, spoken out: voice notes get a voice reply on top of text.
    if (wasVoice) {
      try {
        const speech = cleanForSpeech(reply).slice(0, 800);
        if (speech) await sendVoice(chatId, await synthesize(speech));
      } catch (err) {
        console.warn("[tg] tts reply failed (text already sent):", err);
      }
    }
  } catch (err) {
    console.error("[tg] batch failed:", err);
    await sendMessage(chatId, "Something went wrong on my side. Try again in a moment.").catch(
      () => {},
    );
  }
}

// Everything else (including /agents/*, gated above) is Flue's app.
app.route("/", flue());

export default app;
