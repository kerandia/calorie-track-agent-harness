import { Redis } from "@upstash/redis";
import type { SessionData, SessionStore } from "@flue/runtime";

// Persistent Flue session store backed by Upstash Redis.
//
// Why this exists: Flue's default Node session store is IN-MEMORY, so all
// conversation history is lost whenever the process restarts — which on Cloud
// Run happens on every deploy and on any instance recycle. That made the agent
// "forget" mid-conversation (e.g. losing a kcal value it had just established).
// Persisting sessions in Redis makes conversation memory survive restarts.

let _redis: Redis | null = null;
const redis = (): Redis => {
  if (!_redis) _redis = Redis.fromEnv();
  return _redis;
};

const TTL_S = 60 * 60 * 24 * 90; // expire abandoned sessions after 90 days
const key = (id: string): string => `flue:sess:${id}`;

export const redisSessionStore: SessionStore = {
  async save(id, data) {
    await redis().set(key(id), data, { ex: TTL_S });
  },
  async load(id) {
    return (await redis().get<SessionData>(key(id))) ?? null;
  },
  async delete(id) {
    await redis().del(key(id));
  },
};
