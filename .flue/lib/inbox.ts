import { Redis } from "@upstash/redis";

// Per-tenant inbox: an ordered Redis list of inbound messages waiting for an
// agent turn, plus the lock that serializes turns per tenant.
//
// A channel's webhook normalizes what arrived into an InboxItem, appends it
// here and pings QStash; the channel's /process route drains the list in
// order and coalesces a burst (an album of photos, "here you go" + 4 pics,
// three rapid texts) into ONE agent turn. Items are peeked, processed, then
// trimmed — so a hard crash mid-turn leaves them in place for QStash's retry
// instead of dropping them.

let _redis: Redis | null = null;
const redis = (): Redis => {
  if (!_redis) _redis = Redis.fromEnv();
  return _redis;
};

/** A file the channel fetches on demand: a Telegram file_id, an iMessage attachment GUID. */
export type MediaRef = { ref: string; mimeType?: string };

/** Where the reply to an inbound message goes. */
export type ReplyRoute =
  | { channel: "telegram"; chatId: number }
  | { channel: "imessage"; spaceId: string; phone: string };

/** One inbound message, channel-neutral. */
export type InboxItem = {
  /** Channel-native message id (Telegram update_id, Spectrum message id). */
  id: string;
  /** ms epoch, stamped by the webhook — drives the burst-settling wait. */
  received_at: number;
  /**
   * The conversation it came from. A linked user's Telegram and iMessage
   * messages share one inbox (one tenant, one session), so each item carries
   * its own reply route. Absent only on items queued before routes existed.
   */
  via?: ReplyRoute;
  text?: string;
  photos?: MediaRef[];
  voice?: MediaRef;
  /** Part of an album that arrives one photo at a time: wait longer before acting. */
  album?: boolean;
};

export const routeKey = (route: ReplyRoute): string =>
  route.channel === "telegram" ? `telegram:${route.chatId}` : `imessage:${route.spaceId}`;

/**
 * The leading items that came from the same conversation — one agent turn's
 * worth, answered on that conversation's channel. `closed` is true when a
 * message from another conversation follows, so this run can't grow.
 */
export function leadingRun(
  items: InboxItem[],
  fallback: ReplyRoute,
): { route: ReplyRoute; items: InboxItem[]; closed: boolean } {
  const route = items[0]?.via ?? fallback;
  const key = routeKey(route);
  let n = 0;
  while (n < items.length && routeKey(items[n]!.via ?? fallback) === key) n++;
  return { route, items: items.slice(0, n), closed: n < items.length };
}

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

/** Undo a push whose QStash ping failed (the channel will redeliver). */
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
