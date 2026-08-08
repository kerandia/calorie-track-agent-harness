// Fish Audio client — ASR (voice note → text) and TTS (reply → voice).
// Contracts verified from docs.fish.audio api-reference:
//   POST https://api.fish.audio/v1/asr  multipart/form-data { audio, language?, ignore_timestamps? }
//   POST https://api.fish.audio/v1/tts  application/json { text, format, reference_id? } + `model` header
// Both: Authorization: Bearer FISH_AUDIO_TOKEN. TTS responds with raw audio bytes.

const token = (): string => {
  const t = process.env.FISH_AUDIO_TOKEN;
  if (!t) throw new Error("FISH_AUDIO_TOKEN not set");
  return t;
};

export async function transcribe(
  audio: Uint8Array,
  filename = "voice.ogg",
): Promise<string> {
  const form = new FormData();
  form.append(
    "audio",
    new Blob([audio as BlobPart], { type: "application/octet-stream" }),
    filename,
  );
  form.append("ignore_timestamps", "true");

  const res = await fetch("https://api.fish.audio/v1/asr", {
    method: "POST",
    headers: { Authorization: `Bearer ${token()}` },
    body: form,
  });
  if (!res.ok) {
    throw new Error(
      `fish asr ${res.status}: ${await res.text().catch(() => "")}`,
    );
  }
  const data = (await res.json()) as { text?: string };
  return (data.text ?? "").trim();
}

/** Synthesize speech. Returns opus audio bytes (Telegram voice-note codec). */
export async function synthesize(text: string): Promise<Uint8Array> {
  const body: Record<string, unknown> = {
    text,
    format: "opus",
    normalize: true,
  };
  const voiceId = process.env.FISH_VOICE_ID;
  if (voiceId) body.reference_id = voiceId;

  const res = await fetch("https://api.fish.audio/v1/tts", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token()}`,
      "Content-Type": "application/json",
      model: process.env.FISH_TTS_MODEL || "s2.1-pro-free",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(
      `fish tts ${res.status}: ${await res.text().catch(() => "")}`,
    );
  }
  return new Uint8Array(await res.arrayBuffer());
}

/** TTS chokes on emoji/markdown clutter — feed it clean prose. */
export function cleanForSpeech(text: string): string {
  return text
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, "")
    .replace(/[*_`#>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
