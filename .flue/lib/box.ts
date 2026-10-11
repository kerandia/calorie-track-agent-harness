import { EphemeralBox } from "@upstash/box";

export type SessionBox = EphemeralBox;

export async function createSessionBox(tenantId: string): Promise<SessionBox> {
  return EphemeralBox.create({
    runtime: "python",
    ttl: 600,
    env: { TENANT_ID: tenantId },
  });
}

/** Single-quote a string for sh, so it can be wrapped (e.g. in `timeout 45 sh -c …`). */
export const shellQuote = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`;
