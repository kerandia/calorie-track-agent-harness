// Minimal Telegram Bot API client (plain fetch — no grammy dependency here;
// this runs inside the Flue server's webhook path in production).

const api = (method: string): string => {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN not set");
  return `https://api.telegram.org/bot${token}/${method}`;
};

export async function sendMessage(chatId: number, text: string): Promise<void> {
  const res = await fetch(api("sendMessage"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      // Previews stay disabled: Telegram's preview crawler GETs URLs in
      // messages, which would consume one-time login links.
      link_preview_options: { is_disabled: true },
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

/** Download the largest photo in a message as base64 jpeg. */
export async function downloadPhotoBase64(
  fileId: string,
): Promise<{ base64: string; mimeType: string } | null> {
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
  const buf = Buffer.from(await dl.arrayBuffer());
  return { base64: buf.toString("base64"), mimeType: "image/jpeg" };
}

// ── Telegram update types (the subset we handle) ──────────────────────────

export type TgUpdate = {
  update_id: number;
  message?: {
    message_id: number;
    from?: { id: number };
    chat?: { id: number };
    text?: string;
    caption?: string;
    photo?: { file_id: string }[];
  };
};
