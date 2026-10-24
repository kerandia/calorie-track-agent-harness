import { Redis } from "@upstash/redis";

// The Monday digest: last 7 days of product metrics (lib/metrics.ts) against
// the 7 before, with the things worth a look called out. Sent by Sezar to the
// admins (Redis set `admins`, Telegram ids) when QStash's weekly schedule hits
// /internal/digest.

let _redis: Redis | null = null;
const redis = (): Redis => {
  if (!_redis) _redis = Redis.fromEnv();
  return _redis;
};

export type DayStats = {
  date: string;
  active: string[];
  turns: Record<string, number>;
  tools: Record<string, number>;
  toolErrors: Record<string, number>;
  tokens: { in: number; out: number; calls: number };
  latency: number[];
  errors: Record<string, number>;
  shell: Record<string, number>;
  spend: Record<string, number>;
};

/** Features whose silence is news: shipped, but nobody (or the model) uses them. */
export const WATCHED_TOOLS = [
  "web_search",
  "read_page",
  "place_details",
  "travel_times",
  "outdoor_conditions",
  "import_google_maps_list",
  "log_meal",
  "dashboard_link",
];

const CHANNELS = ["telegram", "imessage"];

const nums = (h: Record<string, unknown> | null | undefined): Record<string, number> =>
  Object.fromEntries(Object.entries(h ?? {}).map(([k, v]) => [k, Number(v) || 0]));

export const datesBack = (n: number, from = new Date()): string[] =>
  Array.from({ length: n }, (_, i) => new Date(from.getTime() - i * 86_400_000).toISOString().slice(0, 10));

export async function loadDays(dates: string[], db: Redis = redis()): Promise<DayStats[]> {
  const p = db.pipeline();
  for (const d of dates) {
    p.smembers(`m:active:${d}`);
    p.hgetall(`m:turns:${d}`);
    p.hgetall(`m:tools:${d}`);
    p.hgetall(`m:toolerr:${d}`);
    p.hgetall(`m:tokens:${d}`);
    p.lrange(`m:latency:${d}`, 0, -1);
    p.hgetall(`m:errors:${d}`);
    p.hgetall(`m:shell:${d}`);
    p.hgetall(`m:spend:${d}`);
  }
  const r = (await p.exec()) as unknown[];
  return dates.map((date, i) => {
    const o = i * 9;
    const tokens = nums(r[o + 4] as Record<string, unknown>);
    return {
      date,
      active: ((r[o] as string[]) ?? []).map(String),
      turns: nums(r[o + 1] as Record<string, unknown>),
      tools: nums(r[o + 2] as Record<string, unknown>),
      toolErrors: nums(r[o + 3] as Record<string, unknown>),
      tokens: { in: tokens.in ?? 0, out: tokens.out ?? 0, calls: tokens.calls ?? 0 },
      latency: ((r[o + 5] as unknown[]) ?? []).map(Number).filter(Number.isFinite),
      errors: nums(r[o + 6] as Record<string, unknown>),
      shell: nums(r[o + 7] as Record<string, unknown>),
      spend: nums(r[o + 8] as Record<string, unknown>),
    };
  });
}

export function percentile(values: number[], p: number): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

const sumMaps = (maps: Record<string, number>[]): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const m of maps) for (const [k, v] of Object.entries(m)) out[k] = (out[k] ?? 0) + v;
  return out;
};

const top = (m: Record<string, number>, n: number): [string, number][] =>
  Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, n);

export type WeekSummary = {
  activeUsers: number;
  activeUsersBefore: number;
  newUsers: number;
  totalUsers: number;
  /** Of users first seen the week before, how many came back this week. */
  returning: { cohort: number; back: number };
  turns: number;
  turnsBefore: number;
  byChannel: Record<string, number>;
  p50?: number;
  p95?: number;
  errors: number;
  errorKinds: Record<string, number>;
  tools: Record<string, number>;
  toolErrors: Record<string, number>;
  unusedFeatures: string[];
  shell: Record<string, number>;
  tokens: { in: number; out: number; calls: number };
  spend: Record<string, number>;
};

/** `week` and `before` are 7 days each, newest first; `first` maps uid → first active date. */
export function summarizeWeek(week: DayStats[], before: DayStats[], first: Record<string, string>): WeekSummary {
  const active = new Set(week.flatMap((d) => d.active));
  const activeBefore = new Set(before.flatMap((d) => d.active));
  const weekDates = new Set(week.map((d) => d.date));
  const beforeDates = new Set(before.map((d) => d.date));
  const cohort = Object.entries(first).filter(([, d]) => beforeDates.has(d)).map(([uid]) => uid);
  const turnsOf = (days: DayStats[]) =>
    days.reduce((n, d) => n + CHANNELS.reduce((m, c) => m + (d.turns[c] ?? 0), 0), 0);
  const tools = sumMaps(week.map((d) => d.tools));
  const errorKinds = sumMaps(week.map((d) => d.errors));
  const latency = week.flatMap((d) => d.latency);
  return {
    activeUsers: active.size,
    activeUsersBefore: activeBefore.size,
    newUsers: Object.values(first).filter((d) => weekDates.has(d)).length,
    totalUsers: Object.keys(first).length,
    returning: { cohort: cohort.length, back: cohort.filter((u) => active.has(u)).length },
    turns: turnsOf(week),
    turnsBefore: turnsOf(before),
    byChannel: Object.fromEntries(CHANNELS.map((c) => [c, week.reduce((n, d) => n + (d.turns[c] ?? 0), 0)])),
    p50: percentile(latency, 50),
    p95: percentile(latency, 95),
    errors: Object.values(errorKinds).reduce((a, b) => a + b, 0),
    errorKinds,
    tools,
    toolErrors: sumMaps(week.map((d) => d.toolErrors)),
    unusedFeatures: WATCHED_TOOLS.filter((t) => !tools[t]),
    shell: sumMaps(week.map((d) => d.shell)),
    tokens: week.reduce(
      (t, d) => ({ in: t.in + d.tokens.in, out: t.out + d.tokens.out, calls: t.calls + d.tokens.calls }),
      { in: 0, out: 0, calls: 0 },
    ),
    spend: sumMaps(week.map((d) => d.spend)),
  };
}

const delta = (now: number, before: number): string =>
  before === 0 ? (now ? " (new)" : "") : ` (${now >= before ? "+" : ""}${Math.round(((now - before) / before) * 100)}%)`;

const kTokens = (n: number): string => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));

export function formatDigest(s: WeekSummary, dashboardUrl?: string): string {
  const secs = (n: number) => `${n < 10 ? n : Math.round(n)}s`;
  const lines: (string | undefined)[] = [
    "Sezar — last 7 days",
    "",
    `Users: ${s.activeUsers} active${delta(s.activeUsers, s.activeUsersBefore)}, ${s.newUsers} new, ${s.totalUsers} all-time`,
    s.returning.cohort
      ? `Returning: ${s.returning.back} of ${s.returning.cohort} who started the week before came back`
      : undefined,
    `Turns: ${s.turns}${delta(s.turns, s.turnsBefore)} — Telegram ${s.byChannel.telegram ?? 0}, iMessage ${s.byChannel.imessage ?? 0}`,
    s.p50 !== undefined ? `Reply time: ${secs(s.p50)} typical, ${secs(s.p95!)} slowest 5%` : undefined,
    `Model: ${s.tokens.calls} calls, ${kTokens(s.tokens.in)} tokens in / ${kTokens(s.tokens.out)} out`,
    Object.keys(s.spend).length
      ? `Metered spend: ${Object.entries(s.spend).map(([k, v]) => `${k} $${v.toFixed(2)}`).join(", ")}`
      : undefined,
    "",
    `Most used: ${top(s.tools, 6).map(([t, n]) => `${t} ${n}`).join(", ") || "—"}`,
    Object.keys(s.shell).length ? `Sandbox: ${top(s.shell, 5).map(([t, n]) => `${t} ${n}`).join(", ")}` : undefined,
  ];

  const flags: string[] = [];
  if (s.turns && s.errors / s.turns > 0.05) flags.push(`${s.errors} errors on ${s.turns} turns (${top(s.errorKinds, 3).map(([k, n]) => `${k} ${n}`).join(", ")})`);
  if (s.p95 !== undefined && s.p95 > 120) flags.push(`slowest 5% of replies take ${secs(s.p95)}`);
  const failing = top(s.toolErrors, 3).filter(([, n]) => n > 0);
  if (failing.length) flags.push(`tool errors: ${failing.map(([t, n]) => `${t} ${n}`).join(", ")}`);
  if (s.turns && s.unusedFeatures.length) flags.push(`never used this week: ${s.unusedFeatures.join(", ")}`);
  const fetches = Object.entries(s.shell).filter(([k]) => k.startsWith("curl") || k.startsWith("wget")).reduce((n, [, v]) => n + v, 0);
  if (fetches) flags.push(`the sandbox fetched the web ${fetches}× — web_search may be getting skipped`);
  if (flags.length) lines.push("", "Worth a look:", ...flags.map((f) => `• ${f}`));
  if (dashboardUrl) lines.push("", `Details: ${dashboardUrl}/dashboard/admin`);
  return lines
    .filter((l): l is string => l !== undefined)
    .filter((l, i, a) => l !== "" || (i > 0 && a[i - 1] !== ""))
    .join("\n")
    .trim();
}

export async function buildDigest(now = new Date()): Promise<string> {
  const dates = datesBack(14, now);
  const days = await loadDays(dates);
  const first = ((await redis().hgetall<Record<string, string>>("m:first")) ?? {}) as Record<string, string>;
  return formatDigest(summarizeWeek(days.slice(0, 7), days.slice(7), first), process.env.DASHBOARD_URL?.replace(/\/+$/, ""));
}

/** Telegram chat ids of the admins (private chat id = user id). */
export async function adminChatIds(): Promise<number[]> {
  const members = ((await redis().smembers("admins")) ?? []).map(String);
  return members.filter((m) => /^\d+$/.test(m)).map(Number);
}
