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

/**
 * The alias key for an iMessage handle: phone numbers by E.164, anything else
 * (an Apple ID email) lowercased. Linked handles live in t:{tenant}:phone.
 */
export const aliasKey = (handle: string): string => {
  const e164 = normalizePhone(handle);
  return e164 ? phoneKey(e164) : `ident:handle:${handle.trim().toLowerCase()}`;
};
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

/** The tenant an iMessage handle (number or email) is linked to, if any. */
export async function tenantForHandle(handle: string): Promise<string | null> {
  return getString(aliasKey(handle));
}

/**
 * Link a verified handle (E.164 number or Apple ID email) to a tenant,
 * replacing any previous link on either side: the latest verified owner wins.
 */
export async function linkPhone(handle: string, tenantId: string): Promise<void> {
  const value = normalizePhone(handle) ?? handle.trim().toLowerCase();
  const [previousTenant, previousHandle] = await Promise.all([
    getString(aliasKey(value)),
    getString(tenantPhoneKey(tenantId)),
  ]);
  const pipe = redis().pipeline();
  if (previousTenant && previousTenant !== tenantId) pipe.del(tenantPhoneKey(previousTenant));
  if (previousHandle && previousHandle !== value) pipe.del(aliasKey(previousHandle));
  pipe.set(aliasKey(value), tenantId);
  pipe.set(tenantPhoneKey(tenantId), value);
  await pipe.exec();
}

/** Remove the tenant's linked number. Returns the number that was linked. */
export async function unlinkPhone(tenantId: string): Promise<string | null> {
  const handle = await getString(tenantPhoneKey(tenantId));
  if (!handle) return null;
  const pipe = redis().pipeline();
  pipe.del(tenantPhoneKey(tenantId));
  pipe.del(aliasKey(handle));
  await pipe.exec();
  return handle;
}

// ── Linking from the iMessage side ─────────────────────────────────────────
// Telegram's contact button only proves the number of the Telegram account,
// and iMessage may run on another number or an Apple ID email. So: /link on
// iMessage returns a short code, and /link <code> sent from Telegram — where
// the sender is authenticated — joins that iMessage handle to the account.

const codeKey = (code: string): string => `link-code:${code}`;

/** A one-time, 10-minute code standing for this iMessage tenant. */
export async function createLinkCode(fromTenant: string): Promise<string> {
  for (let i = 0; i < 5; i++) {
    const code = String(100000 + (crypto.getRandomValues(new Uint32Array(1))[0]! % 900000));
    if ((await redis().set(codeKey(code), fromTenant, { ex: 600, nx: true })) === "OK") return code;
  }
  throw new Error("couldn't allocate a link code");
}

/** The iMessage tenant a code stood for; null when unknown, used or expired. */
export async function consumeLinkCode(code: string): Promise<string | null> {
  if (!/^\d{6}$/.test(code)) return null;
  const v = await redis().getdel<string | number>(codeKey(code));
  return v === null || v === undefined ? null : String(v);
}
