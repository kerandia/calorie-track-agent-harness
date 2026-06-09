import { Redis } from "@upstash/redis";

let _redis: Redis | null = null;
const redis = (): Redis => {
  if (!_redis) _redis = Redis.fromEnv();
  return _redis;
};

const TOKEN_TTL_S = 600; // 10 minutes

/**
 * Issue a one-time dashboard login token bound to a Telegram id.
 * Stored at `login:{token}` with a TTL; the dashboard consumes (and deletes)
 * it to establish a session. Secure because only the bot — which knows the
 * Telegram-verified sender id — can mint one, and it's sent only to that
 * user's chat.
 *
 * NOTE: the link sent to the user must point at a side-effect-free landing
 * page that POSTs the token (and the bot must disable link previews) —
 * Telegram's preview crawler GETs any URL in a message and would otherwise
 * consume the token before the user can click it.
 */
export async function createLoginToken(tenantId: string): Promise<string> {
  const token = crypto.randomUUID().replace(/-/g, "");
  const key = `login:${token}`;
  await redis().set(key, tenantId, { ex: TOKEN_TTL_S });
  const readback = await redis().get(key);
  if (String(readback) !== tenantId) {
    throw new Error(`login token readback failed (got ${String(readback)})`);
  }
  return token;
}
