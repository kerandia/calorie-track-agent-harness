import { Redis } from "@upstash/redis";

// Same magic-link token mint as src/login.ts, but usable from the Flue app's
// webhook path (`.flue/` and `src/` are separate compilation roots, so the
// tiny helper is duplicated rather than cross-imported).

let _redis: Redis | null = null;
const redis = (): Redis => {
  if (!_redis) _redis = Redis.fromEnv();
  return _redis;
};

const TOKEN_TTL_S = 600;

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
