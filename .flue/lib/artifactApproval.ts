import { createHash, randomUUID } from "node:crypto";
import { Redis } from "@upstash/redis";

export type ArtifactAction = "publish_page" | "update_page" | "publish_map" | "update_map" | "delete_artifact";
export type PendingArtifactAction = { action: ArtifactAction; args: Record<string, unknown> };
type ApprovalStore = Pick<Redis, "set" | "getdel">;
let client: Redis | undefined;
const store = () => client ??= Redis.fromEnv();
const key = (tenant: string, token: string) =>
  `artifact-approval:${createHash("sha256").update(tenant).digest("hex")}:${token}`;

/** Saved arguments, not model-provided "confirmed: true", are the approved action. */
export async function requestArtifactApproval(tenant: string, pending: PendingArtifactAction, db: ApprovalStore = store()): Promise<string> {
  if (Buffer.byteLength(JSON.stringify(pending)) > 256 * 1024) throw new Error("Draft too large");
  const token = randomUUID();
  await db.set(key(tenant, token), pending, { ex: 600, nx: true });
  return token;
}

/** Only a standalone command from the authenticated user can consume approval. */
export async function consumeArtifactApproval(tenant: string, text: string, db?: ApprovalStore): Promise<PendingArtifactAction | null | undefined> {
  const match = /^\/approve ([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/.exec(text.trim());
  if (!match) return undefined;
  return (db ?? store()).getdel<PendingArtifactAction>(key(tenant, match[1]!));
}
