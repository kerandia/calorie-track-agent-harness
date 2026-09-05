import { Redis } from "@upstash/redis";
import type { TgUpdate } from "./telegramApi.js";

// Per-tenant inbox: an ordered Redis list of Telegram updates waiting for an
// agent turn, plus the lock that serializes turns per tenant.
//
// The webhook appends here and pings QStash; /tg/process drains the list in
// order and coalesces a burst (an album of photos, "here you go" + 4 pics,
// three rapid texts) into ONE agent turn. Items are peeked, processed, then
// trimmed — so a hard crash mid-turn leaves them in place for QStash's retry
// instead of dropping them.

let _redis: Redis | null = null;
const redis = (): Redis => {
  if (!_redis) _redis = Redis.fromEnv();
  return _redis;
};

export type InboxItem = {
  update_id: number;
  /** ms epoch, stamped by the webhook — drives the burst-settling wait. */
  received_at: number;
  message: NonNullable<TgUpdate["message"]>;
};

// A backlog older than this is already a failure; don't let dead keys pile up.
const INBOX_TTL_S = 60 * 60;

const inboxKey = (tenantId: string): string => `t:${tenantId}:inbox`;
const lockKey = (tenantId: string): string => `lock:turn:${tenantId}`;

/** Append an update; returns the new inbox length. */
export async function pushInbox(
  tenantId: string,
  item: InboxItem,
): Promise<number> {
  const pipe = redis().pipeline();
  pipe.rpush(inboxKey(tenantId), item);
  pipe.expire(inboxKey(tenantId), INBOX_TTL_S);
  const [len] = await pipe.exec<[number, number]>();
  return len;
}

/** Undo a push whose QStash ping failed (Telegram will redeliver the update). */
export async function removeInboxItem(
  tenantId: string,
  item: InboxItem,
): Promise<void> {
  await redis().lrem(inboxKey(tenantId), 1, item);
}

/** Everything currently waiting, oldest first. Does not remove. */
export async function peekInbox(tenantId: string): Promise<InboxItem[]> {
  return (await redis().lrange<InboxItem>(inboxKey(tenantId), 0, -1)) ?? [];
}

/** Drop the first `count` items (the batch that was just handled). */
export async function trimInbox(tenantId: string, count: number): Promise<void> {
  if (count <= 0) return;
  await redis().ltrim(inboxKey(tenantId), count, -1);
}

export async function inboxLength(tenantId: string): Promise<number> {
  return redis().llen(inboxKey(tenantId));
}

export async function acquireTurnLock(
  tenantId: string,
  ttlS: number,
): Promise<boolean> {
  const r = await redis().set(lockKey(tenantId), "1", { nx: true, ex: ttlS });
  return r === "OK";
}

export async function releaseTurnLock(tenantId: string): Promise<void> {
  await redis().del(lockKey(tenantId));
}
