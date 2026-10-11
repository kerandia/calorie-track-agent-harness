import { flue, observe, registerProvider } from "@flue/runtime/app";
import { Hono } from "hono";
import { Redis } from "@upstash/redis";
import {
  answerCallbackQuery,
  clearButtons,
  sendMessage,
  telegramChannel,
  telegramInboxItem,
  type TgUpdate,
} from "./lib/telegramApi.js";
import { imessageChannel, parseImessageWebhook } from "./lib/imessage.js";
import { toBubbles, type Channel, type ChannelAction } from "./lib/channel.js";
import { prepareForVision, type VisionImage } from "./lib/images.js";
import { linkPhone, normalizePhone, tenantForPhone, unlinkPhone } from "./lib/identity.js";
import { createLoginToken } from "./lib/loginToken.js";
import { cleanForSpeech, synthesize } from "./lib/fishAudio.js";
import { audioFormatFor, transcribeVoice } from "./lib/stt.js";
import { MAIN_MODEL_CONTEXT_WINDOW, MAIN_MODEL_ID } from "./lib/models.js";
import { assertTenantId, toAgentMessage } from "./lib/message.js";
import {
  formatInboundMessageLog,
  formatOutboundReplyLog,
  toolResultCharCount,
} from "../src/logging.js";
import {
  acquireTurnLock,
  inboxLength,
  leadingRun,
  peekInbox,
  pushInbox,
  releaseTurnLock,
  removeInboxItem,
  trimInbox,
  type InboxItem,
  type MediaRef,
  type ReplyRoute,
} from "./lib/inbox.js";

// Structured run telemetry → Cloud Run Logs Explorer (queryable JSON lines).
// This is the observability layer; no external platform needed at this scale.
// One line per model call (`llm_turn`: duration, tokens, stop reason), one per
// tool call (`tool_call`: name, duration, error, result size), one per run.
// Without these, a 5-minute turn was a black box.
observe((event) => {
  const e = event as unknown as Record<string, unknown> & { type: string };
  switch (event.type) {
    case "run_end":
      console.log(
        JSON.stringify({
          evt: "agent_run_end",
          runId: e.runId,
          isError: e.isError ?? false,
          durationMs: e.durationMs,
        }),
      );
      return;
    case "turn": {
      const usage = (e.usage ?? {}) as Record<string, unknown>;
      console.log(
        JSON.stringify({
          evt: "llm_turn",
          runId: e.runId,
          durationMs: e.durationMs,
          model: e.model,
          stopReason: e.stopReason,
          isError: e.isError ?? false,
          input: usage.input ?? usage.inputTokens,
          output: usage.output ?? usage.outputTokens,
          ...(e.error ? { error: String(e.error).slice(0, 200) } : {}),
        }),
      );
      return;
    }
    case "tool_call": {
      console.log(
        JSON.stringify({
          evt: "tool_call",
          runId: e.runId,
          tool: e.toolName,
          durationMs: e.durationMs,
          isError: e.isError ?? false,
          resultChars: toolResultCharCount(e.result),
        }),
      );
      return;
    }
    default:
      return;
  }
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
      contextWindow: MAIN_MODEL_CONTEXT_WINDOW,
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

// ── Reasoning effort for agent turns ──────────────────────────────────────
//
// GLM-5.3-Flash "thinks" before every answer and those hidden tokens are the
// dominant latency cost of a turn: one map revision produced ~3k reasoning
// tokens on top of a 1.5k-token tool call (147s wall clock). Nebius honours
// OpenAI's `reasoning_effort` (measured: "low" → ~1 reasoning token, same
// tool-call quality), but Flue registers custom models with reasoning:false
// and pi-ai then never sends the field. There is no hook for it, so the
// field is added at the HTTP layer, only for chat-completion requests to
// Nebius that carry `tools` (agent turns — the vision call has none and does
// better with thinking on). NEBIUS_REASONING_EFFORT=off disables this.
{
  const NEBIUS_CHAT = "https://api.tokenfactory.nebius.com/v1/chat/completions";
  const effort = (process.env.NEBIUS_REASONING_EFFORT ?? "low").toLowerCase();
  if (effort !== "off") {
    const realFetch = globalThis.fetch.bind(globalThis);
    globalThis.fetch = (async (input, init) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const body = init?.body;
      if (url === NEBIUS_CHAT && typeof body === "string" && body.includes('"tools"')) {
        try {
          const json = JSON.parse(body) as Record<string, unknown>;
          if (json.model === MAIN_MODEL_ID && json.reasoning_effort === undefined) {
            json.reasoning_effort = effort;
            return realFetch(input, { ...init, body: JSON.stringify(json) });
          }
        } catch {
          /* not JSON — pass through untouched */
        }
      }
      return realFetch(input, init);
    }) as typeof fetch;
    console.log(`[llm] reasoning_effort=${effort} for ${MAIN_MODEL_ID} tool turns`);
  }
}

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
//
// iMessage (Photon Spectrum) runs the same pipeline: /im/webhook → inbox →
// QStash → /im/process. Everything past the webhook is channel-neutral and
// talks back through a `Channel` (lib/channel.ts).

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
// the remainder to a fresh request. A batch started at the deadline may still
// run a full agent turn, so deadline + turn timeout must stay under 600s, and
// the lock TTL must outlive that sum (a turn that publishes a map or writes a
// page has been measured at 2-5 minutes; the old 300s cut those off after the
// work was done and told the user the model "hiccuped").
const LOCK_TTL_S = 600;
const DRAIN_DEADLINE_MS = 60_000;
const AGENT_TIMEOUT_MS = 480_000;
// After this long in one turn, send a short heads-up so the user isn't staring
// at a typing indicator wondering whether anything is happening.
const SLOW_TURN_NOTE_MS = 40_000;
const SLOW_TURN_NOTES = [
  "on it — this one takes me a minute",
  "still working, give me a moment",
  "building it now, hang tight",
];

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

/**
 * Ask QStash to run a channel's /process route for one tenant. Cheap if a
 * drain is already running.
 */
async function enqueueDrain(
  path: "/tg/process" | "/im/process",
  body: { tenantId: string } & Record<string, unknown>,
): Promise<boolean> {
  const res = await fetch(
    `https://qstash.upstash.io/v2/publish/${env("SERVICE_URL")}${path}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env("QSTASH_TOKEN")}`,
        "Content-Type": "application/json",
        "Upstash-Forward-x-process-secret": env("INTERNAL_API_SECRET"),
        "Upstash-Retries": "3",
      },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) {
    console.error(
      `[queue] QStash publish to ${path} failed ${res.status}: ${await res.text().catch(() => "")}`,
    );
  }
  return res.ok;
}

/**
 * Append a webhook's normalized item to the tenant inbox and schedule a drain.
 * False means nothing was kept, so the channel's redelivery starts clean.
 */
async function acceptInbound(
  dedupeKey: string,
  tenantId: string,
  item: InboxItem,
  drain: () => Promise<boolean>,
): Promise<"queued" | "duplicate" | "failed"> {
  const fresh = await redis().set(dedupeKey, "1", { nx: true, ex: 3600 });
  if (fresh !== "OK") return "duplicate";
  await pushInbox(tenantId, item);
  if (!(await drain())) {
    await removeInboxItem(tenantId, item).catch(() => {});
    await redis().del(dedupeKey).catch(() => {});
    return "failed";
  }
  return "queued";
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

  // Confirm / Cancel taps under a draft. A tap becomes the same /approve or
  // /cancel command the user could type, queued like any message, so it is
  // decided by code (tenant-scoped token) before the model runs.
  const cb = update?.callback_query;
  if (update && cb) {
    const choice = /^(ap|cx):([a-f0-9-]{36})$/.exec(cb.data ?? "");
    const chatId = cb.message?.chat.id;
    await answerCallbackQuery(cb.id, choice ? (choice[1] === "ap" ? "on it…" : "cancelled") : undefined);
    if (!choice || !chatId) return c.json({ ok: true });
    if (cb.message) await clearButtons(chatId, cb.message.message_id);
    const tenantId = assertTenantId(String(cb.from.id));
    const outcome = await acceptInbound(
      `tg:update:${update.update_id}`,
      tenantId,
      {
        id: String(update.update_id),
        received_at: Date.now(),
        via: { channel: "telegram", chatId },
        text: `/${choice[1] === "ap" ? "approve" : "cancel"} ${choice[2]}`,
      },
      () => enqueueDrain("/tg/process", { tenantId, chatId }),
    );
    if (outcome === "failed") return c.json({ error: "enqueue failed" }, 500);
    return c.json({ ok: true });
  }

  // Number linking is answered here, at the Telegram edge: it needs Telegram's
  // contact button and never needs the agent.
  if (update && msg?.chat?.id && msg.from?.id && (msg.contact || linkCommand(msg.text))) {
    const fresh = await redis().set(`tg:update:${update.update_id}`, "1", { nx: true, ex: 3600 });
    if (fresh === "OK") await handleTelegramLinking(msg);
    return c.json({ ok: true });
  }

  // Handle plain user messages with text, a photo, or a voice note.
  if (
    !update ||
    !msg?.chat?.id ||
    !msg.from?.id ||
    (!msg.text && !msg.photo && !msg.voice)
  ) {
    return c.json({ ok: true });
  }

  const tenantId = assertTenantId(String(msg.from.id));
  const chatId = msg.chat.id;
  // Dedupe: Telegram redelivers updates if it thinks the webhook failed.
  const outcome = await acceptInbound(
    `tg:update:${update.update_id}`,
    tenantId,
    telegramInboxItem(update.update_id, msg, Date.now()),
    () => enqueueDrain("/tg/process", { tenantId, chatId }),
  );
  if (outcome === "failed") return c.json({ error: "enqueue failed" }, 500);
  return c.json({ ok: true });
});

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
  return c.json(
    await drainTenant(tenantId, { channel: "telegram", chatId }, () =>
      enqueueDrain("/tg/process", { tenantId, chatId }),
    ),
  );
});

// Photon Spectrum → POST /im/webhook. Signed with the per-webhook secret that
// `./deploy-cloudrun.sh imessage-webhook` stored as SPECTRUM_WEBHOOK_SECRET.
// 401/400 are fatal to Spectrum (no retry); 5xx is retried for ~30s.
app.post("/im/webhook", async (c) => {
  const secret = process.env.SPECTRUM_WEBHOOK_SECRET;
  if (!secret) return c.json({ error: "imessage not configured" }, 503);

  const rawBody = new Uint8Array(await c.req.arrayBuffer());
  const headers: Record<string, string> = {};
  c.req.raw.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });
  const parsed = await parseImessageWebhook({ rawBody, headers, secret });
  if (!parsed.ok) {
    console.warn(`[imessage] webhook rejected: ${parsed.reason}`);
    return c.json({ error: parsed.reason }, parsed.status);
  }
  const delivery = parsed.delivery;
  if (!delivery?.item) return c.json({ ok: true });

  // A number linked from Telegram (/link) lands in that existing account.
  const e164 = normalizePhone(delivery.handle);
  const tenantId = (e164 && (await tenantForPhone(e164))) || delivery.tenantId;
  const { spaceId, phone } = delivery;
  // Dedupe: Spectrum delivers at-least-once; the message id is stable across retries.
  const outcome = await acceptInbound(
    `im:msg:${delivery.item.id}`,
    tenantId,
    delivery.item,
    () => enqueueDrain("/im/process", { tenantId, spaceId, phone }),
  );
  if (outcome === "failed") return c.json({ error: "enqueue failed" }, 500);
  return c.json({ ok: true });
});

app.post("/im/process", async (c) => {
  if (c.req.header("x-process-secret") !== env("INTERNAL_API_SECRET")) {
    return c.json({ error: "forbidden" }, 403);
  }
  const body = (await c.req.json().catch(() => null)) as {
    tenantId?: string;
    spaceId?: string;
    phone?: string;
  } | null;
  if (!body?.tenantId || !body.spaceId || !body.phone) return c.json({ ok: true });
  const job = {
    tenantId: assertTenantId(body.tenantId),
    spaceId: body.spaceId,
    phone: body.phone,
  };
  return c.json(
    await drainTenant(
      job.tenantId,
      { channel: "imessage", spaceId: job.spaceId, phone: job.phone },
      () => enqueueDrain("/im/process", job),
    ),
  );
});

const channelFor = (route: ReplyRoute): Channel =>
  route.channel === "telegram"
    ? telegramChannel(route.chatId)
    : imessageChannel(route.spaceId, route.phone);

/**
 * Peek the inbox for the next turn: the leading run of messages from one
 * conversation, waiting briefly while a burst is still arriving. `fallback`
 * routes items queued before items carried their own route.
 */
async function collectBatch(
  tenantId: string,
  fallback: ReplyRoute,
): Promise<{ route: ReplyRoute; items: InboxItem[] }> {
  const started = Date.now();
  for (;;) {
    const run = leadingRun(await peekInbox(tenantId), fallback);
    if (run.items.length === 0 || run.closed) return run;
    const last = run.items[run.items.length - 1]!;
    const settle = last.album ? ALBUM_SETTLE_MS : SETTLE_MS;
    const wait = last.received_at + settle - Date.now();
    if (wait <= 0 || Date.now() - started > MAX_SETTLE_WAIT_MS) return run;
    await sleep(Math.min(wait, 1500));
  }
}

/**
 * Drain one tenant's inbox in order, one agent turn per burst, each answered
 * on the channel it came from (a linked user's Telegram and iMessage share
 * the inbox). `requeue` schedules a fresh drain when this one runs out of time.
 */
async function drainTenant(
  tenantId: string,
  fallback: ReplyRoute,
  requeue: () => Promise<boolean>,
): Promise<{ ok: true; deferred?: true; continued?: true }> {
  const started = Date.now();

  for (;;) {
    if (!(await acquireTurnLock(tenantId, LOCK_TTL_S))) {
      // Another request is draining this tenant. It re-checks the inbox after
      // releasing the lock, so nothing we appended can be stranded.
      return { ok: true, deferred: true };
    }

    let continueLater = false;
    try {
      for (;;) {
        if (Date.now() - started > DRAIN_DEADLINE_MS) {
          continueLater = true;
          break;
        }
        const batch = await collectBatch(tenantId, fallback);
        if (batch.items.length === 0) break;
        const channel = channelFor(batch.route);
        const typing = () => void channel.sendTyping().catch(() => {});
        const typingTimer = setInterval(typing, channel.typingRefreshMs);
        typing();
        try {
          await handleBatch(channel, tenantId, batch.items);
        } finally {
          clearInterval(typingTimer);
          await channel.stopTyping?.().catch(() => {});
        }
        await trimInbox(tenantId, batch.items.length);
      }
    } finally {
      await releaseTurnLock(tenantId).catch(() => {});
    }

    if (continueLater) {
      // Hand the rest to a fresh request rather than tripping Cloud Run's timeout.
      await requeue();
      return { ok: true, continued: true };
    }
    if ((await inboxLength(tenantId)) === 0) return { ok: true };
    // Something landed between our last empty peek and the lock release: go again.
  }
}

type LinkCommand = "link" | "unlink";
const linkCommand = (text: string | undefined): LinkCommand | null => {
  const cmd = (text ?? "").trim().toLowerCase();
  if (cmd === "/link" || cmd === "/imessage") return "link";
  if (cmd === "/unlink") return "unlink";
  return null;
};

/**
 * /link → Telegram's share-my-number button. A shared contact links the number
 * only when Telegram says it is the sender's own (contact.user_id === from.id);
 * from then on iMessage from that number reaches this same tenant.
 */
async function handleTelegramLinking(msg: NonNullable<TgUpdate["message"]>): Promise<void> {
  const chatId = msg.chat!.id;
  const tenantId = assertTenantId(String(msg.from!.id));
  try {
    if (msg.contact) {
      const e164 = normalizePhone(msg.contact.phone_number);
      if (msg.contact.user_id !== msg.from!.id || !e164) {
        await sendMessage(chatId, "That's not your own number. Send /link and tap the button to share yours.");
        return;
      }
      await linkPhone(e164, tenantId);
      console.log(JSON.stringify({ evt: "phone_linked", channel: "telegram" }));
      await sendMessage(
        chatId,
        `Linked ${e164}. Texting me on iMessage from that number now reaches this same Sezar — same meals, profile and memory. Send /unlink to undo.`,
        { remove_keyboard: true },
      );
      return;
    }
    if (linkCommand(msg.text) === "unlink") {
      const e164 = await unlinkPhone(tenantId);
      await sendMessage(
        chatId,
        e164 ? `Unlinked ${e164}. iMessage from it is a separate chat again.` : "No number is linked.",
      );
      return;
    }
    await sendMessage(
      chatId,
      "Tap the button to share your phone number. Then iMessage from that number reaches this same Sezar.",
      {
        keyboard: [[{ text: "Share my phone number", request_contact: true }]],
        resize_keyboard: true,
        one_time_keyboard: true,
      },
    );
  } catch (err) {
    console.error("[telegram] linking failed:", err);
    await sendMessage(chatId, "Couldn't link that right now. Try again in a sec.").catch(() => {});
  }
}

async function sendLoginLink(channel: Channel, tenantId: string): Promise<void> {
  try {
    const token = await createLoginToken(tenantId);
    const dash = process.env.DASHBOARD_URL ?? "http://localhost:3100";
    await channel.sendText(
      `Here's your dashboard login link (valid 10 minutes, one-time):\n${dash}/login/confirm?token=${token}`,
    );
  } catch (err) {
    console.error(`[${channel.name}] login token failed:`, err);
    await channel.sendText("Couldn't generate a login link right now. Try again in a sec.");
  }
}

const isLoginCommand = (text: string | undefined): boolean => {
  const cmd = (text ?? "").trim().toLowerCase();
  return cmd === "/login" || cmd === "/dashboard" || cmd === "/web";
};

/** Map with at most `limit` calls in flight; results keep input order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** Confirm / Cancel buttons for a staged draft (Telegram; other channels reply "yes"). */
const approvalActions = (a: { token: string; action: string }): ChannelAction[] => [
  {
    label: a.action === "delete_artifact" ? "Take it offline" : a.action.startsWith("update") ? "Update it" : "Publish",
    data: `ap:${a.token}`,
  },
  { label: "Cancel", data: `cx:${a.token}` },
];

/** Download one photo and make it vision-ready; null on any failure. */
async function loadPhoto(channel: Channel, media: MediaRef): Promise<VisionImage | null> {
  try {
    const file = await channel.fetchMedia(media);
    return file ? await prepareForVision(file.bytes, file.mimeType) : null;
  } catch (err) {
    console.warn(`[${channel.name}] photo load failed:`, err);
    return null;
  }
}

/** Turn one burst of inbound messages into one agent turn, and deliver the reply. */
async function handleBatch(
  channel: Channel,
  tenantId: string,
  items: InboxItem[],
): Promise<void> {
  try {
    // /login-style commands are answered directly; they never need the agent.
    const turnItems: InboxItem[] = [];
    for (const it of items) {
      if (isLoginCommand(it.text)) await sendLoginLink(channel, tenantId);
      else if (linkCommand(it.text)) {
        // Linking needs Telegram's contact button; elsewhere, point there.
        await channel.sendText(
          "Send /link to Sezar on Telegram and tap the button. Then this chat becomes the same Sezar.",
        );
      } else turnItems.push(it);
    }
    if (turnItems.length === 0) return;

    const texts: string[] = [];
    let wasVoice = false;
    for (const it of turnItems) {
      if (it.text) texts.push(it.text);
      if (!it.voice) continue;
      const file = await channel.fetchMedia(it.voice).catch((err: unknown) => {
        console.error(`[${channel.name}] voice download failed:`, err);
        return null;
      });
      if (!file) {
        await channel.sendText("couldn't grab that voice note — try again?");
        continue;
      }
      try {
        const spoken = await transcribeVoice(file.bytes, audioFormatFor(file.mimeType));
        if (spoken) {
          texts.push(spoken);
          wasVoice = true;
        } else {
          await channel.sendText("heard mostly silence there — try again?");
        }
      } catch (err) {
        console.error(`[${channel.name}] asr failed:`, err);
        await channel.sendText("couldn't make out that voice note — mind typing it?");
      }
    }

    // Photos: made vision-ready, capped per turn. Two at a time: decoding a
    // HEIC holds the full bitmap (a 48MP iPhone photo is ~190MB of RGBA), and
    // six in parallel would not fit the 1GiB instance.
    const photoRefs = turnItems.flatMap((it) => it.photos ?? []);
    const analyzed = photoRefs.slice(0, MAX_IMAGES_PER_TURN);
    const photosDropped = photoRefs.length - analyzed.length;
    const downloads = await mapLimit(analyzed, 2, (ref) => loadPhoto(channel, ref));
    const images = downloads.filter((d): d is VisionImage => d !== null);
    if (images.length < analyzed.length) {
      console.warn(
        `[${channel.name}] ${analyzed.length - images.length} of ${analyzed.length} photo downloads failed`,
      );
    }

    const text = texts.join("\n");
    if (!text && images.length === 0) {
      if (analyzed.length > 0) {
        await channel.sendText("couldn't read that image — try again?");
      }
      return;
    }

    console.log(
      formatInboundMessageLog({
        tenantId,
        text,
        imageCount: images.length,
        voice: wasVoice,
        burstSize: turnItems.length,
      }),
    );

    const port = process.env.PORT ?? "8080";
    const envelope = toAgentMessage({
      tenantId,
      channel: channel.name,
      externalMessageId: turnItems[0]!.id,
      text,
    });
    const slowNote = setTimeout(() => {
      void channel
        .sendText(SLOW_TURN_NOTES[Math.floor(Math.random() * SLOW_TURN_NOTES.length)]!)
        .catch(() => {});
    }, SLOW_TURN_NOTE_MS);
    let res: Response;
    try {
      // The URL's <id> segment is Flue's agent INSTANCE id and part of the
      // session storage key. It used to be the Telegram update_id, so every
      // message opened a brand-new session and the bot had no conversation
      // memory at all (45 one-turn sessions for one user). One instance per
      // tenant = one continuous conversation per tenant.
      res = await fetch(
        `http://127.0.0.1:${port}/agents/chat/${encodeURIComponent(tenantId)}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-internal-secret": env("INTERNAL_API_SECRET"),
          },
          body: JSON.stringify({
            ...envelope,
            images,
            voice: wasVoice,
            photosDropped: photosDropped > 0 ? photosDropped : undefined,
          }),
          signal: AbortSignal.timeout(AGENT_TIMEOUT_MS),
        },
      );
    } finally {
      clearTimeout(slowNote);
    }

    if (!res.ok) {
      const errorBody = await res.text().catch(() => "");
      console.error(
        JSON.stringify({
          evt: "agent_request_failed",
          status: res.status,
          responseChars: errorBody.length,
        }),
      );
      await channel.sendText("the model just hiccuped on me — try again in a moment.");
      return; // don't retry LLM failures — user was told
    }
    const data = (await res.json()) as {
      result?: { reply?: string; approval?: { token: string; action: string } };
    };
    const reply = data.result?.reply;
    const runId = res.headers.get("x-flue-run-id") ?? "?";
    if (!reply) {
      console.error(`[${channel.name}] missing result.reply (run ${runId})`);
      await channel.sendText("(no reply)");
      return;
    }
    console.log(formatOutboundReplyLog({ tenantId, text: reply, runId }));

    const bubbles = toBubbles(reply, channel.maxBubbles);
    const approval = data.result?.approval;
    const actions = approval ? approvalActions(approval) : undefined;
    for (let i = 0; i < bubbles.length; i++) {
      const last = i === bubbles.length - 1;
      await channel.sendText(bubbles[i]!, last && actions ? { actions } : undefined);
      if (!last) await sleep(450);
    }

    // Spoken in, spoken out: voice notes get a voice reply on top of text.
    if (wasVoice && channel.sendVoice) {
      try {
        const speech = cleanForSpeech(reply).slice(0, 800);
        if (speech) await channel.sendVoice(await synthesize(speech));
      } catch (err) {
        console.warn(`[${channel.name}] tts reply failed (text already sent):`, err);
      }
    }
  } catch (err) {
    console.error(`[${channel.name}] batch failed:`, err);
    await channel.sendText("Something went wrong on my side. Try again in a moment.").catch(
      () => {},
    );
  }
}

// Everything else (including /agents/*, gated above) is Flue's app.
app.route("/", flue());

export default app;
