import { createHash, randomUUID } from "node:crypto";
import { Redis } from "@upstash/redis";

// Publishing gate. A write tool never acts: it stages the draft here and the
// user's own reply decides. The decision is parsed by this code, before the
// model runs — never by the model — so model output can't publish anything.
//
// Ways to decide, all from the channel-authenticated user:
//   - Telegram's Publish / Cancel buttons (callback data carries the token);
//   - a standalone "yes" / "no" (or evet / hayır, 👍 …) while a draft waits —
//     it applies to the most recent draft only, and a plain "yes" with nothing
//     pending is just a message for the model;
//   - the explicit /approve <token> or /cancel <token> command.

export type ArtifactAction = "publish_page" | "update_page" | "publish_map" | "update_map" | "delete_artifact";
export type PendingArtifactAction = { action: ArtifactAction; args: Record<string, unknown> };
type ApprovalStore = Pick<Redis, "set" | "getdel">;
let client: Redis | undefined;
const store = () => client ??= Redis.fromEnv();
const hash = (tenant: string) => createHash("sha256").update(tenant).digest("hex");
const key = (tenant: string, token: string) => `artifact-approval:${hash(tenant)}:${token}`;
const latestKey = (tenant: string) => `artifact-approval-latest:${hash(tenant)}`;

const TTL_S = 600;
const TOKEN = "[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}";

/** Saved arguments, not model-provided "confirmed: true", are the approved action. */
export async function requestArtifactApproval(tenant: string, pending: PendingArtifactAction, db: ApprovalStore = store()): Promise<string> {
  if (Buffer.byteLength(JSON.stringify(pending)) > 256 * 1024) throw new Error("Draft too large");
  const token = randomUUID();
  await db.set(key(tenant, token), pending, { ex: TTL_S, nx: true });
  await db.set(latestKey(tenant), token, { ex: TTL_S });
  return token;
}

const YES = new Set([
  "yes", "y", "yep", "yeah", "yup", "ok", "okay", "k", "sure", "publish", "approve", "approved", "go",
  "go ahead", "do it", "ship it", "send it", "👍", "✅", "evet", "tamam", "olur", "onay", "onayla", "yayınla",
]);
const NO = new Set([
  "no", "n", "nope", "nah", "cancel", "stop", "don't", "dont", "👎", "❌", "hayır", "hayir", "iptal", "vazgeç", "vazgec",
]);

const asWord = (text: string): string =>
  text.trim().toLowerCase().replace(/[\s.!,]+$/u, "").replace(/\s+/g, " ");

export type ApprovalDecision =
  | { decision: "approve"; pending: PendingArtifactAction | null }
  | { decision: "cancel"; cancelled: boolean };

/**
 * The user's decision on a staged draft, or undefined when the message isn't
 * one (it then goes to the model as usual).
 */
export async function resolveApprovalReply(
  tenant: string,
  text: string,
  db: ApprovalStore = store(),
): Promise<ApprovalDecision | undefined> {
  const cmd = new RegExp(`^/(approve|cancel) (${TOKEN})$`).exec(text.trim());
  if (cmd) {
    const pending = await db.getdel<PendingArtifactAction>(key(tenant, cmd[2]!));
    return cmd[1] === "approve" ? { decision: "approve", pending } : { decision: "cancel", cancelled: pending !== null };
  }

  const word = asWord(text);
  const yes = YES.has(word);
  if (!yes && !NO.has(word)) return undefined;
  const token = await db.getdel<string>(latestKey(tenant));
  if (!token) return undefined;
  const pending = await db.getdel<PendingArtifactAction>(key(tenant, String(token)));
  // Already decided (a button press) or expired: this "yes" is just a message.
  if (!pending) return undefined;
  return yes ? { decision: "approve", pending } : { decision: "cancel", cancelled: true };
}
