import { createHmac } from "node:crypto";
import { Redis } from "@upstash/redis";

// Product metrics in Redis: who was active when, what got used, how fast,
// what broke. Pseudonymous and content-free by construction:
//   - a user is an HMAC of the tenant id under a server-side key, so a
//     Telegram id can't be recovered by hashing candidates;
//   - nothing from a message, a place or a meal is recorded — only counts,
//     durations, tool names and coarse command kinds.
// Read by the dashboard's Admin tab and the weekly digest (lib/digest.ts).
//
// Keys (daily ones expire after ~13 months):
//   m:first                 hash  uid → first active date        (cohorts)
//   m:active:{date}         set   uids active that day           (DAU/WAU/MAU, retention)
//   m:turns:{date}          hash  channel / voice / photos → n
//   m:tools:{date}          hash  tool → calls;  m:toolerr:{date} tool → errors
//   m:tokens:{date}         hash  in / out / calls
//   m:latency:{date}        list  turn seconds (capped)
//   m:errors:{date}         hash  kind → n
//   m:shell:{date}          hash  sandbox command kind → n
//   m:spend:{date}          hash  provider → USD (where the provider reports it)

let _redis: Redis | null = null;
const redis = (): Redis => {
  if (!_redis) _redis = Redis.fromEnv();
  return _redis;
};

const TTL_S = 400 * 24 * 60 * 60;
const MAX_LATENCY_SAMPLES = 2000;

const day = (d = new Date()): string => d.toISOString().slice(0, 10);

/** Pseudonymous user id for metrics. */
export function metricsUid(tenantId: string, key = process.env.METRICS_KEY ?? process.env.INTERNAL_API_SECRET ?? ""): string {
  return createHmac("sha256", `sezar-metrics:${key}`).update(tenantId).digest("hex").slice(0, 16);
}

/** Metrics must never break a turn: failures are logged and dropped. */
async function safely(what: string, run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch (err) {
    console.warn(JSON.stringify({ evt: "metrics_failed", what, error: String(err).slice(0, 120) }));
  }
}

export async function recordTurn(t: {
  tenantId: string;
  channel: string;
  seconds: number;
  voice?: boolean;
  photos?: number;
}): Promise<void> {
  await safely("turn", async () => {
    const d = day();
    const uid = metricsUid(t.tenantId);
    const p = redis().pipeline();
    p.hsetnx("m:first", uid, d);
    p.sadd(`m:active:${d}`, uid);
    p.expire(`m:active:${d}`, TTL_S);
    p.hincrby(`m:turns:${d}`, t.channel, 1);
    if (t.voice) p.hincrby(`m:turns:${d}`, "voice", 1);
    if (t.photos) p.hincrby(`m:turns:${d}`, "photos", t.photos);
    p.expire(`m:turns:${d}`, TTL_S);
    p.lpush(`m:latency:${d}`, Math.round(t.seconds * 10) / 10);
    p.ltrim(`m:latency:${d}`, 0, MAX_LATENCY_SAMPLES - 1);
    p.expire(`m:latency:${d}`, TTL_S);
    await p.exec();
  });
}

const bump = (what: string, key: string, field: string, by = 1) =>
  safely(what, async () => {
    const p = redis().pipeline();
    p.hincrby(key, field, by);
    p.expire(key, TTL_S);
    await p.exec();
  });

export const recordError = (kind: string) => bump("error", `m:errors:${day()}`, kind);

export async function recordToolCall(tool: string, isError: boolean): Promise<void> {
  await bump("tool", `m:tools:${day()}`, tool);
  if (isError) await bump("toolerr", `m:toolerr:${day()}`, tool);
}

export async function recordTokens(input: number, output: number): Promise<void> {
  await safely("tokens", async () => {
    const key = `m:tokens:${day()}`;
    const p = redis().pipeline();
    p.hincrby(key, "in", Math.max(0, Math.round(input)));
    p.hincrby(key, "out", Math.max(0, Math.round(output)));
    p.hincrby(key, "calls", 1);
    p.expire(key, TTL_S);
    await p.exec();
  });
}

export async function recordSpend(provider: string, usd: number): Promise<void> {
  if (!(usd > 0)) return;
  await safely("spend", async () => {
    const key = `m:spend:${day()}`;
    const p = redis().pipeline();
    p.hincrbyfloat(key, provider, usd);
    p.expire(key, TTL_S);
    await p.exec();
  });
}

/**
 * What kind of command the sandbox ran, without its arguments: the program,
 * plus the host for fetches ("curl maps.google.com"). Enough to see whether
 * the model reaches for the shell instead of a proper tool.
 */
export function shellCommandKind(cmd: string): string {
  const words = cmd.trim().split(/\s+/);
  let i = 0;
  while (i < words.length && /^(sudo|env|[A-Z_]+=\S*)$/.test(words[i]!)) i++;
  const program = (words[i] ?? "").split("/").pop()!.replace(/[^a-z0-9._+-]/gi, "").slice(0, 24) || "unknown";
  if (program === "curl" || program === "wget") {
    const url = /https?:\/\/([a-z0-9.-]+)/i.exec(cmd)?.[1]?.toLowerCase();
    return url ? `${program} ${url}` : program;
  }
  return program;
}

export const recordShellCommand = (cmd: string) => bump("shell", `m:shell:${day()}`, shellCommandKind(cmd));
