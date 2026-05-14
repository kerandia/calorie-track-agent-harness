import { TelegramChannel } from "./channel/telegram.js";

const token = process.env.TELEGRAM_BOT_TOKEN;
const flueUrl = process.env.FLUE_URL ?? "http://localhost:3583";

if (!token) {
  console.error("Missing TELEGRAM_BOT_TOKEN. Copy .env.example to .env and fill it in.");
  process.exit(1);
}

const channel = new TelegramChannel(token);

channel.onMessage(async (msg, reply) => {
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
    });
    if (!res.ok) {
      const body = await res.text();
      console.error(`Flue ${res.status}: ${body}`);
      await reply("Something went wrong on my side. Try again in a moment.");
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
    console.error("Failed to reach Flue:", err);
    await reply("I can't reach my brain right now. One sec...");
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
