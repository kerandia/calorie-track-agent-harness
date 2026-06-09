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
 */
export async function createLoginToken(tenantId: string): Promise<string> {
  const token = crypto.randomUUID().replace(/-/g, "");
  await redis().set(`login:${token}`, tenantId, { ex: TOKEN_TTL_S });
  return token;
}
