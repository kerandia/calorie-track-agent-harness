import { Redis } from "@upstash/redis";

// Cross-channel identity: one person, one tenant, whichever app they text from.
//
// Tenants are keyed by the first channel a person used (a Telegram user id,
// or `im:<handle>` for iMessage). Telegram never gives a bot the user's phone
// number, so the two can't be matched automatically. Linking is explicit: the
// user taps Telegram's "share my number" button, and the number counts only
// when the shared contact's `user_id` is the sender's own id — Telegram fills
// that field server-side, so it attests the number belongs to this account.
// iMessage's side is Apple's sender handle, delivered in a signed webhook.
//
// Never link from a number typed in a message. Numbers get recycled, so the
// most recent Telegram-verified owner of a number wins, and /unlink drops it.

let _redis: Redis | null = null;
const redis = (): Redis => {
  if (!_redis) _redis = Redis.fromEnv();
  return _redis;
};

const phoneKey = (e164: string): string => `ident:phone:${e164}`;
const tenantPhoneKey = (tenantId: string): string => `t:${tenantId}:phone`;

/** Upstash JSON-decodes values, so a numeric Telegram id comes back as a number. */
const getString = async (key: string): Promise<string | null> => {
  const v = await redis().get<string | number>(key);
  return v === null || v === undefined ? null : String(v);
};

/**
 * E.164 form of a phone number as Telegram or Apple report it
 * ("491701234567", "+49 170 1234567"). Null for anything that isn't one —
 * including iMessage email handles, which can't be linked by number.
 */
export function normalizePhone(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.includes("@")) return null;
  const digits = trimmed.replace(/[\s().-]/g, "").replace(/^\+/, "");
  if (!/^[1-9]\d{6,14}$/.test(digits)) return null;
  return `+${digits}`;
}

/** The tenant a phone number is linked to, if any. */
export async function tenantForPhone(e164: string): Promise<string | null> {
  return getString(phoneKey(e164));
}

/** Link a verified number to a tenant, replacing any previous link on either side. */
export async function linkPhone(e164: string, tenantId: string): Promise<void> {
  const [previousTenant, previousPhone] = await Promise.all([
    getString(phoneKey(e164)),
    getString(tenantPhoneKey(tenantId)),
  ]);
  const pipe = redis().pipeline();
  if (previousTenant && previousTenant !== tenantId) pipe.del(tenantPhoneKey(previousTenant));
  if (previousPhone && previousPhone !== e164) pipe.del(phoneKey(previousPhone));
  pipe.set(phoneKey(e164), tenantId);
  pipe.set(tenantPhoneKey(tenantId), e164);
  await pipe.exec();
}

/** Remove the tenant's linked number. Returns the number that was linked. */
export async function unlinkPhone(tenantId: string): Promise<string | null> {
  const e164 = await getString(tenantPhoneKey(tenantId));
  if (!e164) return null;
  const pipe = redis().pipeline();
  pipe.del(tenantPhoneKey(tenantId));
  pipe.del(phoneKey(e164));
  await pipe.exec();
  return e164;
}
