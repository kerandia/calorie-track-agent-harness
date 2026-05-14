import { EphemeralBox } from "@upstash/box";

export type SessionBox = EphemeralBox;

export async function createSessionBox(tenantId: string): Promise<SessionBox> {
  return EphemeralBox.create({
    runtime: "python",
    ttl: 600,
    env: { TENANT_ID: tenantId },
  });
}
