import { cookies } from "next/headers";
import { createHmac, createHash, timingSafeEqual } from "node:crypto";

const SESSION_COOKIE = "cal_session";
const MAX_AUTH_AGE_S = 86400; // reject Telegram payloads older than a day

export type TelegramAuthData = {
  id: string;
  first_name?: string;
  last_name?: string;
  username?: string;
  photo_url?: string;
  auth_date: string;
  hash: string;
};

/**
 * Verify a Telegram Login Widget payload.
 * https://core.telegram.org/widgets/login#checking-authorization
 * secret = SHA256(bot_token); HMAC-SHA256(data_check_string, secret) === hash.
 */
export function verifyTelegramAuth(
  data: Record<string, string>,
  botToken: string,
): { ok: true; tenantId: string } | { ok: false; reason: string } {
  const { hash, ...rest } = data;
  if (!hash) return { ok: false, reason: "missing hash" };

  const dataCheckString = Object.keys(rest)
    .sort()
    .map((key) => `${key}=${rest[key]}`)
    .join("\n");

  const secret = createHash("sha256").update(botToken).digest();
  const computed = createHmac("sha256", secret)
    .update(dataCheckString)
    .digest("hex");

  const a = Buffer.from(computed, "hex");
  const b = Buffer.from(hash, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: "bad hash" };
  }

  const authDate = Number(rest.auth_date ?? 0);
  if (!authDate || Date.now() / 1000 - authDate > MAX_AUTH_AGE_S) {
    return { ok: false, reason: "stale auth" };
  }
  if (!rest.id) return { ok: false, reason: "missing id" };
  return { ok: true, tenantId: rest.id };
}

// ── Session cookie (signed, httpOnly) ─────────────────────────────────────

function sign(value: string, secret: string): string {
  return createHmac("sha256", secret).update(value).digest("hex");
}

export function makeSessionToken(tenantId: string, secret: string): string {
  const payload = `${tenantId}.${Math.floor(Date.now() / 1000)}`;
  return `${payload}.${sign(payload, secret)}`;
}

export function verifySessionToken(
  token: string | undefined,
  secret: string,
): string | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [tenantId, ts, sig] = parts;
  const payload = `${tenantId}.${ts}`;
  const expected = sign(payload, secret);
  const a = Buffer.from(sig, "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return tenantId;
}

export async function setSession(tenantId: string): Promise<void> {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET not set");
  const jar = await cookies();
  jar.set(SESSION_COOKIE, makeSessionToken(tenantId, secret), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
}

export async function clearSession(): Promise<void> {
  const jar = await cookies();
  jar.delete(SESSION_COOKIE);
}

export async function getSessionTenantId(): Promise<string | null> {
  const secret = process.env.SESSION_SECRET;
  if (!secret) return null;
  const jar = await cookies();
  return verifySessionToken(jar.get(SESSION_COOKIE)?.value, secret);
}
