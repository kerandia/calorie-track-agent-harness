import { Spectrum, richlink } from "@spectrum-ts/core";
import { slimEnvelopeSchema, verifySpectrumSignature } from "@spectrum-ts/core/webhook";
import { imessage } from "@spectrum-ts/imessage";
import type { Channel } from "./channel.js";
import type { InboxItem, MediaRef } from "./inbox.js";
import { assertTenantId } from "./message.js";
import { isPreviewLink, splitPreviewLinks } from "./previewLinks.js";

// iMessage through Photon Spectrum (managed iMessage lines).
//
// Inbound: Spectrum POSTs a signed JSON "messages" event to /im/webhook. We
// verify and normalize it ourselves instead of using `app.webhook()`: that
// helper runs its handler AFTER the HTTP response, and Cloud Run (request-based
// billing) gives a process no CPU once the response is sent — the inbox write
// would race the throttle. Here the inbox write happens before we ack.
//
// Outbound: Spectrum has no HTTP send API. Replies, typing and attachment
// downloads go through the SDK's gRPC client, created lazily inside the
// /im/process request. We never read `app.messages`, so the SDK never opens
// its own inbound stream — webhooks stay the only inbound path.

/** Tenant ids for iMessage users: the Apple handle (E.164 number or email). */
export const imessageTenantId = (handle: string): string =>
  assertTenantId(`im:${handle.trim().toLowerCase()}`);

export type ImessageDelivery = {
  /** The tenant this handle gets when it isn't linked to another account. */
  tenantId: string;
  /** Apple's sender handle as delivered: an E.164 number or an email. */
  handle: string;
  /** Spectrum space id, e.g. "any;-;+15550100" for a DM. */
  spaceId: string;
  /** Line the conversation lives on: an E.164 number, or "shared" (pooled). */
  phone: string;
  /** Null when the event carries nothing we act on (a tapback, a video…). */
  item: InboxItem | null;
};

export type ParseResult =
  | { ok: true; delivery: ImessageDelivery | null }
  | { ok: false; status: 400 | 401; reason: string };

type Slim = Record<string, unknown>;

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** Fold one content arm into the item being built. */
function addContent(content: Slim, into: InboxItem): void {
  switch (content.type) {
    case "text": {
      const t = str(content.text)?.trim();
      if (t) into.text = into.text ? `${into.text}\n${t}` : t;
      return;
    }
    case "richlink": {
      const url = str(content.url);
      if (url) into.text = into.text ? `${into.text}\n${url}` : url;
      return;
    }
    case "attachment": {
      const ref = str(content.id);
      const mimeType = str(content.mimeType)?.toLowerCase();
      if (!ref || !mimeType) return;
      const media: MediaRef = { ref, mimeType };
      if (mimeType.startsWith("image/")) (into.photos ??= []).push(media);
      else if (mimeType.startsWith("audio/") && !into.voice) into.voice = media;
      return;
    }
    case "group": {
      // An album: several attachments sent as one message.
      const items = Array.isArray(content.items) ? (content.items as Slim[]) : [];
      for (const it of items) {
        const inner = it.content;
        if (inner && typeof inner === "object") addContent(inner as Slim, into);
      }
      return;
    }
    default:
      // reaction (tapback), contact, poll… — nothing for the agent yet.
      return;
  }
}

/**
 * Verify a Spectrum webhook delivery and normalize it. `headers` keys must be
 * lowercased; `rawBody` must be the exact bytes received.
 */
export async function parseImessageWebhook(input: {
  rawBody: Uint8Array;
  headers: Record<string, string>;
  secret: string;
  now?: number;
}): Promise<ParseResult> {
  const verified = await verifySpectrumSignature(input);
  if (!verified.ok) return { ok: false, status: 401, reason: verified.reason };

  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(input.rawBody));
  } catch {
    return { ok: false, status: 400, reason: "invalid-json" };
  }
  const parsed = slimEnvelopeSchema.safeParse(json);
  if (!parsed.success) return { ok: false, status: 400, reason: "invalid-envelope" };
  const { event, message } = parsed.data;
  const space = (parsed.data.space ?? message.space) as Slim & { id: string };

  // Only 1:1 inbound messages from a known sender. Group chats are out of scope
  // (and unavailable on shared-pool lines anyway).
  if (event !== "messages" || message.direction !== "inbound") return { ok: true, delivery: null };
  if (space.type !== "dm" || !message.sender?.id) return { ok: true, delivery: null };

  const phone = str(space.phone) ?? "shared";
  const item: InboxItem = {
    id: message.id,
    received_at: Date.now(),
    via: { channel: "imessage", spaceId: space.id, phone },
  };
  addContent(message.content as Slim, item);
  const hasContent = Boolean(item.text || item.photos?.length || item.voice);

  return {
    ok: true,
    delivery: {
      tenantId: imessageTenantId(message.sender.id),
      handle: message.sender.id,
      spaceId: space.id,
      phone,
      item: hasContent ? item : null,
    },
  };
}

// ── Outbound (SDK) ─────────────────────────────────────────────────────────

const env = (name: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} not set`);
  return v;
};

let _app: ReturnType<typeof createApp> | null = null;

function createApp() {
  return Spectrum({
    projectId: env("SPECTRUM_PROJECT_ID"),
    projectSecret: env("SPECTRUM_PROJECT_SECRET"),
    providers: [imessage.config()],
    // Info-level SDK logs can carry phone numbers; our own telemetry keeps
    // tenant identifiers and content out of Cloud Run logs.
    options: { logLevel: "warn" },
  });
}

/** One SDK instance per process; a failed init is retried on the next call. */
async function spectrumIm() {
  if (!_app) {
    _app = createApp();
    _app.catch(() => {
      _app = null;
    });
  }
  return imessage(await _app);
}

export function imessageChannel(spaceId: string, phone: string): Channel {
  const space = async () => (await spectrumIm()).space.get(spaceId, { phone });
  return {
    name: "imessage",
    // Several bubbles within seconds is the burst pattern Apple flags as automated.
    maxBubbles: 1,
    typingRefreshMs: 20_000,
    // A dashboard or share URL goes out as its own message. Messages uses the
    // large 1200×630 preview only when the URL is the entire bubble; beside
    // other text it collapses to the compact card. `richlink` is Photon's
    // send with enableLinkPreview, so the bubble is the URL and nothing else.
    // One extra bubble for a link, not a burst: maxBubbles stays 1 for replies.
    sendText: async (text) => {
      const parts = splitPreviewLinks(text);
      const s = await space();
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i]!;
        if (isPreviewLink(part)) await s.send(richlink(part));
        else await s.send(part);
        if (i !== parts.length - 1) await new Promise((r) => setTimeout(r, 400));
      }
    },
    // Typing is cosmetic: never let it fail a turn (or an SDK init error escape).
    sendTyping: async () => {
      await space()
        .then((s) => s.startTyping())
        .catch(() => {});
    },
    stopTyping: async () => {
      await space()
        .then((s) => s.stopTyping())
        .catch(() => {});
    },
    fetchMedia: async (media) => {
      const att = await (await spectrumIm()).getAttachment(media.ref, phone);
      if (!att) return null;
      const bytes = await att.read();
      return { bytes: new Uint8Array(bytes), mimeType: (att.mimeType ?? media.mimeType ?? "").toLowerCase() };
    },
  };
}
