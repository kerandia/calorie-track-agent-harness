import { transcribe as fishTranscribe } from "./fishAudio.js";

// Speech-to-text with a provider chain:
//   1. OpenRouter /v1/audio/transcriptions (model via STT_MODEL, default
//      x-ai/grok-stt-1.0 at $0.10/audio-hour; whisper-large-v3 is the
//      Turkish-proven alternative — flip via env, no deploy needed beyond it)
//   2. Fish Audio ASR as fallback (needs Fish API credit)
// Telegram voice notes are OGG/Opus — "ogg" is an accepted format value on
// OpenRouter's endpoint (verified in their multimodal STT docs). iMessage
// voice memos arrive as AAC in an MP4 container (audio/mp4, audio/x-m4a).

const AUDIO_FORMATS: Record<string, string> = {
  "audio/ogg": "ogg",
  "audio/opus": "ogg",
  "audio/mp4": "m4a",
  "audio/m4a": "m4a",
  "audio/x-m4a": "m4a",
  "audio/aac": "aac",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/x-caf": "caf",
};

/** The `format` value transcribeVoice expects for a voice note's MIME type. */
export const audioFormatFor = (mimeType: string | undefined): string =>
  AUDIO_FORMATS[(mimeType ?? "").toLowerCase().split(";")[0]!.trim()] ?? "ogg";

export async function transcribeVoice(
  audio: Uint8Array,
  format = "ogg",
): Promise<string> {
  const key = process.env.OPENROUTER_API_KEY;
  const model = process.env.STT_MODEL || "x-ai/grok-stt-1.0";

  if (key) {
    try {
      const res = await fetch(
        "https://openrouter.ai/api/v1/audio/transcriptions",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${key}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model,
            input_audio: {
              data: Buffer.from(audio).toString("base64"),
              format,
            },
          }),
        },
      );
      if (res.ok) {
        const data = (await res.json()) as {
          text?: string;
          usage?: { cost?: number };
        };
        console.log(
          `[stt] ${model} ok (cost $${data.usage?.cost ?? "?"})`,
        );
        return (data.text ?? "").trim();
      }
      console.warn(
        `[stt] openrouter ${res.status}: ${(await res.text().catch(() => "")).slice(0, 160)} — falling back to fish`,
      );
    } catch (err) {
      console.warn("[stt] openrouter failed, falling back to fish:", err);
    }
  }

  return fishTranscribe(audio, `voice.${format}`);
}
