import type { MediaRef } from "./inbox.js";
import type { ChannelName } from "./message.js";

/**
 * How the turn pipeline talks back to one conversation. Each messaging channel
 * (Telegram, iMessage via Photon, …) implements this; the drain/turn code in
 * app.ts only ever sees this interface, so a transport can be swapped (e.g.
 * Photon's cloud lines → our own Mac) without touching the pipeline.
 */
export interface Channel {
  readonly name: ChannelName;
  /** Most bubbles one reply may become. */
  readonly maxBubbles: number;
  /** How often to re-send the typing signal while a turn runs. */
  readonly typingRefreshMs: number;
  sendText(text: string): Promise<void>;
  sendTyping(): Promise<void>;
  /** For channels whose typing indicator stays on until cleared. */
  stopTyping?(): Promise<void>;
  /** Voice bubble from OGG/Opus bytes. Channels without it reply in text only. */
  sendVoice?(audio: Uint8Array): Promise<boolean>;
  fetchMedia(media: MediaRef): Promise<{ bytes: Uint8Array; mimeType: string } | null>;
}

/**
 * Blank-line-separated thoughts become separate bubbles (the persona's "Poke"
 * mechanic), at most `max` of them; anything past the cap stays together in
 * the last bubble rather than being dropped.
 */
export function toBubbles(reply: string, max: number): string[] {
  const parts = reply
    .split(/\n{2,}/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 0) return [reply];
  if (parts.length <= max) return parts;
  return [...parts.slice(0, max - 1), parts.slice(max - 1).join("\n\n")];
}
