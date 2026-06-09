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

const FLUE_TIMEOUT_MS = 180_000;

channel.onMessage(async (msg, reply) => {
  const cmd = msg.text.trim().toLowerCase();
  if (cmd === "/login" || cmd === "/dashboard" || cmd === "/web") {
    try {
      const loginToken = await createLoginToken(msg.tenantId);
      const link = `${dashboardUrl}/api/auth/code?token=${loginToken}`;
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
          ? "The model just hiccuped on me. Try again in a moment — if it keeps happening the free model is probably overloaded."
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
    const isTimeout =
      err instanceof DOMException && err.name === "TimeoutError";
    console.error(`Failed to reach Flue${isTimeout ? " (timeout)" : ""}:`, err);
    await reply(
      isTimeout
        ? "Took too long to think — the model's probably overloaded. Try again."
        : "I can't reach my brain right now. Try again in a sec.",
    );
  }
});

const shutdown = async (signal: string) => {
  console.log(`\nReceived ${signal}, stopping bot...`);
  await channel.stop();
  process.exit(0);
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

console.log(`Telegram bot starting (long-polling); Flue at ${flueUrl}`);
await channel.start();
