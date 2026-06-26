import { TelegramChannel } from "./channel/telegram.js";
import { createLoginToken } from "./login.js";

const token = process.env.TELEGRAM_BOT_TOKEN;
const flueUrl = process.env.FLUE_URL ?? "http://localhost:3583";
const dashboardUrl = process.env.DASHBOARD_URL ?? "http://localhost:3100";

if (!token) {
  console.error("Missing TELEGRAM_BOT_TOKEN. Copy .env.example to .env and fill it in.");
  process.exit(1);
}

const channel = new TelegramChannel(token);

const FLUE_TIMEOUT_MS = 240_000;

// Serialize turns per tenant. Flue's session.prompt throws if two prompts run
// on the same session at once, and rapid-fire messages from one user would
// otherwise race. Each tenant gets a promise chain; a new message waits for
// that tenant's previous turn to finish before starting.
const tenantQueues = new Map<string, Promise<unknown>>();
function enqueue(tenantId: string, task: () => Promise<void>): Promise<void> {
  const prev = tenantQueues.get(tenantId) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(task);
  tenantQueues.set(tenantId, next);
  void next.finally(() => {
    if (tenantQueues.get(tenantId) === next) tenantQueues.delete(tenantId);
  });
  return next;
}

async function handleAgentTurn(
  msg: { tenantId: string; text: string; messageId: number; image?: unknown },
  reply: (text: string) => Promise<void>,
): Promise<void> {
  const imageNote = msg.image ? " [+image]" : "";
  console.log(`[${msg.tenantId}]${imageNote} ${msg.text || "(no caption)"}`);
  try {
    const res = await fetch(`${flueUrl}/agents/chat/${msg.messageId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tenantId: msg.tenantId,
        text: msg.text,
        image: msg.image,
      }),
      signal: AbortSignal.timeout(FLUE_TIMEOUT_MS),
    });
    if (!res.ok) {
      const body = await res.text();
      console.error(`Flue ${res.status}: ${body}`);
      const friendly =
        res.status >= 500
          ? "The model just hiccuped on me. Try again in a moment."
          : "Something went wrong on my side. Try again in a moment.";
      await reply(friendly);
      return;
    }
    const runId = res.headers.get("x-flue-run-id") ?? "?";
    const data = (await res.json()) as {
      result?: { reply?: string };
      _meta?: { runId?: string };
    };
    const replyText = data.result?.reply;
    if (!replyText) {
      console.error(`Flue response missing result.reply (run ${runId}):`, JSON.stringify(data));
      await reply("(no reply)");
      return;
    }
    const preview = replyText.length > 200 ? replyText.slice(0, 200) + "..." : replyText;
    console.log(`[${msg.tenantId}] <- (run ${runId}) ${preview}`);
    await reply(replyText);
  } catch (err) {
    const isTimeout = err instanceof DOMException && err.name === "TimeoutError";
    console.error(`Failed to reach Flue${isTimeout ? " (timeout)" : ""}:`, err);
    await reply(
      isTimeout
        ? "That took too long — try again in a moment."
        : "I can't reach my brain right now. Try again in a sec.",
    );
  }
}

channel.onMessage(async (msg, reply) => {
  const cmd = msg.text.trim().toLowerCase();
  if (cmd === "/login" || cmd === "/dashboard" || cmd === "/web") {
    try {
      const loginToken = await createLoginToken(msg.tenantId);
      const link = `${dashboardUrl}/login/confirm?token=${loginToken}`;
      console.log(`[${msg.tenantId}] issued dashboard login link`);
      await reply(
        `Here's your dashboard login link (valid 10 minutes, one-time):\n${link}`,
      );
    } catch (err) {
      console.error("Failed to issue login token:", err);
      await reply("Couldn't generate a login link right now. Try again in a sec.");
    }
    return;
  }

  await enqueue(msg.tenantId, () => handleAgentTurn(msg, reply));
});

const shutdown = async (signal: string) => {
  console.log(`\nReceived ${signal}, stopping bot...`);
  await channel.stop();
  process.exit(0);
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// Don't let a stray rejection take the whole process down — log and keep going.
process.on("unhandledRejection", (err) => {
  console.error("unhandledRejection:", err);
});

// Long-polling is fragile during deploys: Cloud Run briefly runs the old and
// new revision together, so both poll Telegram and the loser gets a 409
// "terminated by other getUpdates". Instead of crashing, retry until the old
// revision drains and we win the poll.
let stopping = false;
const origShutdown = shutdown;
const wrappedShutdown = async (signal: string) => {
  stopping = true;
  await origShutdown(signal);
};
process.removeAllListeners("SIGINT");
process.removeAllListeners("SIGTERM");
process.on("SIGINT", () => wrappedShutdown("SIGINT"));
process.on("SIGTERM", () => wrappedShutdown("SIGTERM"));

async function runBot() {
  for (let attempt = 1; !stopping; attempt++) {
    try {
      console.log(`Telegram bot starting (long-polling); Flue at ${flueUrl}`);
      await channel.start(); // resolves only on graceful stop
      return;
    } catch (err) {
      if (stopping) return;
      console.error(`Bot polling failed (attempt ${attempt}), retrying in 5s:`, err);
      try {
        await channel.stop();
      } catch {
        /* ignore */
      }
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

await runBot();
