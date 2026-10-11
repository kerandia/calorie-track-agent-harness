import { Redis } from "@upstash/redis";
import { FALLBACK_MODEL, MAIN_MODEL, MAIN_MODEL_ID } from "./models.js";

// Circuit breaker for the main model provider.
//
// GLM-5.3-Flash on Nebius normally answers a call in ~3-4 s. When Nebius is
// degraded (seen: median 74 s, max 249 s per call for an hour) a turn blows
// through every budget. We keep the last few Nebius call times; once the
// median of recent calls is slow — or a turn hits its deadline — new turns go
// to the same model on OpenRouter for a cool-down, then Nebius is tried again.
// A turn never switches provider midway: the choice is made at its start.

let _redis: Redis | null = null;
const redis = (): Redis => {
  if (!_redis) _redis = Redis.fromEnv();
  return _redis;
};

const SAMPLES_KEY = "llm:nebius:recent";
const FALLBACK_KEY = "llm:fallback-until";
const SAMPLES = 5;
const SLOW_MS = 25_000;
const COOLDOWN_S = 600;

/** Median of the samples; degraded when there are enough and they're slow. */
export function isDegraded(samplesMs: number[], slowMs = SLOW_MS): boolean {
  if (samplesMs.length < 3) return false;
  const sorted = [...samplesMs].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]! > slowMs;
}

/** Called for every model call (observe hook). Errors count as slow. */
export async function noteModelCall(modelId: string, durationMs: number, isError: boolean): Promise<void> {
  if (modelId !== MAIN_MODEL_ID) return;
  try {
    const p = redis().pipeline();
    p.lpush(SAMPLES_KEY, isError ? SLOW_MS * 10 : Math.round(durationMs));
    p.ltrim(SAMPLES_KEY, 0, SAMPLES - 1);
    p.expire(SAMPLES_KEY, 3600);
    p.lrange(SAMPLES_KEY, 0, -1);
    const out = (await p.exec()) as unknown[];
    const samples = ((out[3] as unknown[]) ?? []).map(Number);
    if (isDegraded(samples)) await tripBreaker("slow_calls");
  } catch {
    /* health tracking must never break a turn */
  }
}

/** Route new turns to the fallback for a cool-down. */
export async function tripBreaker(reason: string): Promise<void> {
  try {
    const set = await redis().set(FALLBACK_KEY, reason, { ex: COOLDOWN_S, nx: true });
    // The next Nebius try starts from a clean slate.
    if (set === "OK") {
      await redis().del(SAMPLES_KEY);
      console.log(JSON.stringify({ evt: "model_fallback_on", reason, minutes: COOLDOWN_S / 60 }));
    }
  } catch {
    /* ignore */
  }
}

/** The model for a new turn. */
export async function pickModel(): Promise<string> {
  try {
    return (await redis().exists(FALLBACK_KEY)) ? FALLBACK_MODEL : MAIN_MODEL;
  } catch {
    return MAIN_MODEL;
  }
}
