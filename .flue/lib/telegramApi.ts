// Minimal Telegram Bot API client (plain fetch — no grammy dependency here;
// this runs inside the Flue server's webhook path in production).

import type { Channel } from "./channel.js";
import type { InboxItem } from "./inbox.js";

const api = (method: string): string => {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN not set");
  return `https://api.telegram.org/bot${token}/${method}`;
};

/** A custom keyboard (e.g. a share-my-number button), or a request to remove it. */
export type ReplyMarkup =
  | {
      keyboard: { text: string; request_contact?: boolean }[][];
      resize_keyboard?: boolean;
      one_time_keyboard?: boolean;
    }
  | { remove_keyboard: true };

export async function sendMessage(
  chatId: number,
  text: string,
  replyMarkup?: ReplyMarkup,
): Promise<void> {
  const res = await fetch(api("sendMessage"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      // Previews stay disabled: Telegram's preview crawler GETs URLs in
      // messages, which would consume one-time login links.
      link_preview_options: { is_disabled: true },
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    }),
  });
  if (!res.ok) {
    console.error(`sendMessage failed ${res.status}: ${await res.text().catch(() => "")}`);
  }
}

export async function sendTyping(chatId: number): Promise<void> {
  await fetch(api("sendChatAction"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, action: "typing" }),
  }).catch(() => {});
}

/** Download any Telegram file by file_id. */
export async function downloadFile(fileId: string): Promise<Uint8Array | null> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const fileRes = await fetch(api("getFile"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file_id: fileId }),
  });
  if (!fileRes.ok) return null;
  const fileData = (await fileRes.json()) as {
    ok: boolean;
    result?: { file_path?: string };
  };
  const path = fileData.result?.file_path;
  if (!path) return null;
  const dl = await fetch(`https://api.telegram.org/file/bot${token}/${path}`);
  if (!dl.ok) return null;
  return new Uint8Array(await dl.arrayBuffer());
}

/** Send a voice bubble (expects OGG/Opus bytes). Non-fatal on failure. */
export async function sendVoice(
  chatId: number,
  audio: Uint8Array,
): Promise<boolean> {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append(
    "voice",
    new Blob([audio as BlobPart], { type: "audio/ogg" }),
    "voice.ogg",
  );
  const res = await fetch(api("sendVoice"), { method: "POST", body: form });
  if (!res.ok) {
    console.warn(
      `sendVoice failed ${res.status}: ${await res.text().catch(() => "")}`,
    );
    return false;
  }
  return true;
}

// ── Telegram update types (the subset we handle) ──────────────────────────

export type TgUpdate = {
  update_id: number;
  message?: {
    message_id: number;
    from?: { id: number };
    chat?: { id: number };
    /** Unix seconds, set by Telegram. */
    date?: number;
    /** Set on every photo of an album; same value across the album. */
    media_group_id?: string;
    text?: string;
    caption?: string;
    photo?: { file_id: string }[];
    voice?: { file_id: string; duration?: number; mime_type?: string };
    /** A shared contact card. `user_id` is set by Telegram, not the sender. */
    contact?: { phone_number: string; user_id?: number };
  };
};

/** Normalize one Telegram message for the inbox. Photos keep only the largest size. */
export function telegramInboxItem(
  updateId: number,
  message: NonNullable<TgUpdate["message"]>,
  receivedAt: number,
): InboxItem {
  const largest = message.photo?.[message.photo.length - 1];
  const text = (message.text ?? message.caption ?? "").trim();
  return {
    id: String(updateId),
    received_at: receivedAt,
    ...(message.chat?.id ? { via: { channel: "telegram" as const, chatId: message.chat.id } } : {}),
    ...(text ? { text } : {}),
    ...(largest ? { photos: [{ ref: largest.file_id, mimeType: "image/jpeg" }] } : {}),
    ...(message.voice
      ? { voice: { ref: message.voice.file_id, mimeType: message.voice.mime_type ?? "audio/ogg" } }
      : {}),
    ...(message.media_group_id ? { album: true } : {}),
  };
}

export function telegramChannel(chatId: number): Channel {
  return {
    name: "telegram",
    maxBubbles: 3,
    // Telegram clears the typing action after ~5s.
    typingRefreshMs: 4000,
    sendText: (text) => sendMessage(chatId, text),
    sendTyping: () => sendTyping(chatId),
    sendVoice: (audio) => sendVoice(chatId, audio),
    fetchMedia: async (media) => {
      const bytes = await downloadFile(media.ref);
      return bytes ? { bytes, mimeType: media.mimeType ?? "application/octet-stream" } : null;
    },
  };
}
