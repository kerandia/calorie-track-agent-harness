import { flue, registerProvider } from "@flue/runtime/app";
import { Hono } from "hono";
import { Redis } from "@upstash/redis";
import {
  downloadPhotoBase64,
  sendMessage,
  sendTyping,
  type TgUpdate,
} from "./lib/telegramApi.js";
import { createLoginToken } from "./lib/loginToken.js";

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
    "MiniMaxAI/MiniMax-M2.5": {
      contextWindow: 196608,
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

// ── Telegram webhook pipeline (scale-to-zero) ──────────────────────────────
//
// Telegram → POST /tg/webhook   fast ack (<1s): verify secret, dedupe, enqueue
// QStash   → POST /tg/process   the actual agent turn, runs inside a billed
//                               request; replies via Telegram sendMessage
//
// Why the queue hop: Telegram retries slow webhooks (duplicate turns), and
// Cloud Run request-based billing throttles CPU outside of requests — so the
// long turn must run inside its own request. QStash provides that + retries.
// Per-tenant serialization is a Redis lock; a locked tenant returns 429 and
// QStash redelivers with backoff.

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

app.post("/tg/webhook", async (c) => {
  if (
    c.req.header("x-telegram-bot-api-secret-token") !==
    env("TELEGRAM_WEBHOOK_SECRET")
  ) {
    return c.json({ error: "forbidden" }, 403);
  }

  const update = (await c.req.json().catch(() => null)) as TgUpdate | null;
  const msg = update?.message;
  // Only handle plain user messages with text or a photo; ack everything else.
  if (!update || !msg?.chat?.id || !msg.from?.id || (!msg.text && !msg.photo)) {
    return c.json({ ok: true });
  }

  // Dedupe: Telegram redelivers updates if it thinks the webhook failed.
  const fresh = await redis().set(`tg:update:${update.update_id}`, "1", {
    nx: true,
    ex: 3600,
  });
  if (fresh !== "OK") return c.json({ ok: true });

  const qstashRes = await fetch(
    `https://qstash.upstash.io/v2/publish/${env("SERVICE_URL")}/tg/process`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env("QSTASH_TOKEN")}`,
        "Content-Type": "application/json",
        "Upstash-Forward-x-process-secret": env("INTERNAL_API_SECRET"),
        "Upstash-Retries": "4",
      },
      body: JSON.stringify(update),
    },
  );
  if (!qstashRes.ok) {
    console.error(
      `[tg] QStash publish failed ${qstashRes.status}: ${await qstashRes.text().catch(() => "")}`,
    );
    // Undo dedupe so Telegram's redelivery gets another chance.
    await redis().del(`tg:update:${update.update_id}`).catch(() => {});
    return c.json({ error: "enqueue failed" }, 500);
  }
  return c.json({ ok: true });
});

app.post("/tg/process", async (c) => {
  if (c.req.header("x-process-secret") !== env("INTERNAL_API_SECRET")) {
    return c.json({ error: "forbidden" }, 403);
  }
  const update = (await c.req.json().catch(() => null)) as TgUpdate | null;
  const msg = update?.message;
  if (!update || !msg?.chat?.id || !msg.from?.id) return c.json({ ok: true });

  const chatId = msg.chat.id;
  const tenantId = String(msg.from.id);
  const text = msg.text ?? msg.caption ?? "";

  // /login magic link — no agent turn needed.
  const cmd = text.trim().toLowerCase();
  if (cmd === "/login" || cmd === "/dashboard" || cmd === "/web") {
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
    return c.json({ ok: true });
  }

  // Per-tenant serialization: Flue throws if two prompts hit one session at
  // once. If a turn is in flight, 429 → QStash redelivers with backoff.
  const lockKey = `lock:turn:${tenantId}`;
  const locked = await redis().set(lockKey, "1", { nx: true, ex: 300 });
  if (locked !== "OK") return c.json({ error: "turn in flight" }, 429);

  const typing = setInterval(() => void sendTyping(chatId), 4000);
  void sendTyping(chatId);
  try {
    let image: { base64: string; mimeType: string } | undefined;
    const largest = msg.photo?.[msg.photo.length - 1];
    if (largest) {
      image = (await downloadPhotoBase64(largest.file_id)) ?? undefined;
      if (!image) {
        await sendMessage(chatId, "Couldn't read that image. Try again?");
        return c.json({ ok: true });
      }
    }

    const imageNote = image ? " [+image]" : "";
    console.log(`[${tenantId}]${imageNote} ${text || "(no caption)"}`);

    const port = process.env.PORT ?? "8080";
    const res = await fetch(
      `http://127.0.0.1:${port}/agents/chat/${update.update_id}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-internal-secret": env("INTERNAL_API_SECRET"),
        },
        body: JSON.stringify({ tenantId, text, image }),
        signal: AbortSignal.timeout(540_000),
      },
    );

    if (!res.ok) {
      console.error(`[tg] agent ${res.status}: ${await res.text().catch(() => "")}`);
      await sendMessage(chatId, "The model just hiccuped on me. Try again in a moment.");
      return c.json({ ok: true }); // don't retry LLM failures — user was told
    }
    const data = (await res.json()) as { result?: { reply?: string } };
    const reply = data.result?.reply;
    const runId = res.headers.get("x-flue-run-id") ?? "?";
    if (!reply) {
      console.error(`[tg] missing result.reply (run ${runId})`);
      await sendMessage(chatId, "(no reply)");
      return c.json({ ok: true });
    }
    console.log(`[${tenantId}] <- (run ${runId}) ${reply.slice(0, 200)}`);
    await sendMessage(chatId, reply);
    return c.json({ ok: true });
  } catch (err) {
    console.error("[tg] process failed:", err);
    await sendMessage(chatId, "Something went wrong on my side. Try again in a moment.").catch(
      () => {},
    );
    return c.json({ ok: true });
  } finally {
    clearInterval(typing);
    await redis().del(lockKey).catch(() => {});
  }
});

// Everything else (including /agents/*, gated above) is Flue's app.
app.route("/", flue());

export default app;
