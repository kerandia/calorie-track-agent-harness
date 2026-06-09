import { Bot } from "grammy";

export type IncomingImage = {
  base64: string;
  mimeType: string;
};

export type IncomingMessage = {
  tenantId: string;
  text: string;
  messageId: number;
  image?: IncomingImage;
};

export type ReplyFn = (text: string) => Promise<void>;
export type MessageHandler = (msg: IncomingMessage, reply: ReplyFn) => Promise<void>;

export interface Channel {
  onMessage(handler: MessageHandler): void;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export class TelegramChannel implements Channel {
  private readonly bot: Bot;
  private readonly token: string;

  constructor(token: string) {
    this.token = token;
    this.bot = new Bot(token);
  }

  onMessage(handler: MessageHandler): void {
    this.bot.on("message:text", async (ctx) => {
      const tenantId = ctx.from?.id != null ? String(ctx.from.id) : "";
      if (!tenantId) return;
      await handler(
        {
          tenantId,
          text: ctx.message.text,
          messageId: ctx.message.message_id,
        },
        async (text) => {
          // Previews disabled: Telegram's preview crawler GETs any URL in a
          // message, which would consume one-time login links.
          await ctx.reply(text, {
            link_preview_options: { is_disabled: true },
          });
        },
      );
    });

    this.bot.on("message:photo", async (ctx) => {
      const tenantId = ctx.from?.id != null ? String(ctx.from.id) : "";
      if (!tenantId) return;

      const photos = ctx.message.photo;
      const largest = photos[photos.length - 1];
      if (!largest) return;

      try {
        const file = await ctx.api.getFile(largest.file_id);
        if (!file.file_path) {
          await ctx.reply("Couldn't read that image. Try again?");
          return;
        }
        const fileUrl = `https://api.telegram.org/file/bot${this.token}/${file.file_path}`;
        const res = await fetch(fileUrl);
        if (!res.ok) {
          console.error(`Telegram file download failed: ${res.status}`);
          await ctx.reply("Couldn't fetch that image from Telegram.");
          return;
        }
        const buffer = Buffer.from(await res.arrayBuffer());
        const base64 = buffer.toString("base64");

        await handler(
          {
            tenantId,
            text: ctx.message.caption ?? "",
            messageId: ctx.message.message_id,
            image: { base64, mimeType: "image/jpeg" },
          },
          async (text) => {
            await ctx.reply(text);
          },
        );
      } catch (err) {
        console.error("photo handler error:", err);
        await ctx.reply("I had trouble reading that image. Try again?");
      }
    });
  }

  async start(): Promise<void> {
    await this.bot.start();
  }

  async stop(): Promise<void> {
    await this.bot.stop();
  }
}
