import { createHash } from "node:crypto";

type InboundMessageLog = {
  tenantId: string;
  text: string;
  imageCount?: number;
  voice?: boolean;
  burstSize?: number;
};

type OutboundReplyLog = {
  tenantId: string;
  text: string;
  runId: string;
};

const tenantRef = (tenantId: string): string =>
  createHash("sha256").update(tenantId).digest("hex").slice(0, 12);

/**
 * Record enough metadata to diagnose message flow without retaining user
 * identifiers or message contents in production logs.
 */
export function formatInboundMessageLog(input: InboundMessageLog): string {
  return JSON.stringify({
    evt: "message_received",
    tenantRef: tenantRef(input.tenantId),
    textChars: input.text.length,
    imageCount: input.imageCount ?? 0,
    voice: input.voice ?? false,
    burstSize: input.burstSize ?? 1,
  });
}

export function formatOutboundReplyLog(input: OutboundReplyLog): string {
  return JSON.stringify({
    evt: "reply_sent",
    tenantRef: tenantRef(input.tenantId),
    runId: input.runId,
    textChars: input.text.length,
  });
}

/** Size-only telemetry for tool results; the result itself must never be logged. */
export function toolResultCharCount(result: unknown): number {
  if (typeof result === "string") return result.length;
  if (
    result &&
    typeof result === "object" &&
    Array.isArray((result as { content?: unknown }).content)
  ) {
    return (result as { content: unknown[] }).content.reduce<number>(
      (total, block) => {
        if (!block || typeof block !== "object") return total;
        const text = (block as { text?: unknown }).text;
        return total + (typeof text === "string" ? text.length : 0);
      },
      0,
    );
  }
  try {
    return JSON.stringify(result ?? "").length;
  } catch {
    return 0;
  }
}
