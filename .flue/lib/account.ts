import { createHash } from "node:crypto";
import { Redis } from "@upstash/redis";
import { aliasKey } from "./identity.js";
import { deleteMap } from "./maproom.js";
import { deletePage } from "./pages.js";
import { listArtifacts } from "./redis.js";
import { deleteTenantVectors } from "./vector.js";

// "Delete everything Sezar keeps about me" (GDPR erasure), started from chat.
//
// It runs here, in the agent, because only the agent holds every credential
// involved: Redis (meals, profile, places, assumptions, photo memory, the
// conversation), Vector (meal embeddings), Blob (published pages) and
// MapToAgent (published maps). The dashboard links here instead of doing a
// partial delete itself.
//
// Two steps, decided by code, never by the model: /deletemydata arms it for
// 10 minutes, and only a standalone "DELETE" from the same user runs it.

let _redis: Redis | null = null;
const redis = (): Redis => {
  if (!_redis) _redis = Redis.fromEnv();
  return _redis;
};

const pendingKey = (tenantId: string): string =>
  `account-delete:${createHash("sha256").update(tenantId).digest("hex")}`;

export const isDeleteCommand = (text: string | undefined): boolean =>
  /^\/(deletemydata|forgetme)$/i.test((text ?? "").trim());

export const DELETE_WARNING =
  "This permanently deletes everything Sezar keeps about you: meals, profile, saved places, what it learned about you, " +
  "photo memory and our conversation — and takes your published pages and maps offline. It can't be undone.\n\n" +
  "To go ahead, reply DELETE (in capitals) within 10 minutes. Anything else cancels.";

export async function armDeletion(tenantId: string): Promise<void> {
  await redis().set(pendingKey(tenantId), "1", { ex: 600 });
}

/**
 * True when this message confirms an armed deletion. Any other message while
 * armed disarms it, so a stray "DELETE" much later can't wipe an account.
 */
export async function consumeDeletionConfirmation(tenantId: string, text: string | undefined): Promise<boolean> {
  const armed = await redis().getdel(pendingKey(tenantId));
  return Boolean(armed) && (text ?? "").trim() === "DELETE";
}

/** A Flue session key belongs to a tenant when its instance id is the tenant id. */
export function isTenantSessionKey(key: string, tenantId: string): boolean {
  const prefix = "flue:sess:agent-session:";
  if (!key.startsWith(prefix)) return false;
  try {
    const parts = JSON.parse(key.slice(prefix.length)) as unknown;
    return Array.isArray(parts) && parts[0] === tenantId;
  } catch {
    return false;
  }
}

type ScanStore = Pick<Redis, "scan">;

/** Every Redis key holding this tenant's data. */
export async function findTenantKeys(tenantId: string, db: ScanStore = redis()): Promise<string[]> {
  const out: string[] = [];
  const sweep = async (match: string, keep: (k: string) => boolean = () => true) => {
    let cursor = "0";
    do {
      const [next, keys] = await db.scan(cursor, { match, count: 500 });
      cursor = String(next);
      for (const k of keys as string[]) if (keep(k)) out.push(k);
    } while (cursor !== "0");
  };
  await sweep(`t:${tenantId}:*`);
  await sweep("flue:sess:agent-session:*", (k) => isTenantSessionKey(k, tenantId));
  return out;
}

export type DeletionReport = { keys: number; pages: number; maps: number; failed: number };

export async function deleteTenantData(tenantId: string): Promise<DeletionReport> {
  const report: DeletionReport = { keys: 0, pages: 0, maps: 0, failed: 0 };

  // Published artifacts first: the registry that lists them lives in Redis.
  for (let offset = 0; ; offset += 100) {
    const batch = await listArtifacts(tenantId, 100, offset);
    for (const a of batch) {
      try {
        if (a.kind === "page") {
          await deletePage(tenantId, a.external_id);
          report.pages++;
        } else {
          await deleteMap(a.external_id);
          report.maps++;
        }
      } catch {
        report.failed++;
      }
    }
    if (batch.length < 100) break;
  }

  await deleteTenantVectors(tenantId).catch(() => {
    report.failed++;
  });

  // The phone alias points at this tenant from outside the t: prefix.
  const phone = await redis().get<string>(`t:${tenantId}:phone`);
  const keys = await findTenantKeys(tenantId);
  if (phone) {
    const alias = aliasKey(String(phone));
    const owner = await redis().get<string | number>(alias);
    if (owner !== null && String(owner) === tenantId) keys.push(alias);
  }
  for (let i = 0; i < keys.length; i += 200) {
    report.keys += await redis().del(...keys.slice(i, i + 200));
  }
  return report;
}
