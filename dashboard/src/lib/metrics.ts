import { Redis } from "@upstash/redis";

// Admin view over the agent's product metrics (written by .flue/lib/metrics.ts).
// Pseudonymous: users are keyed HMACs, and nothing here holds message content.

let _redis: Redis | null = null;
const redis = (): Redis => {
  if (!_redis) _redis = Redis.fromEnv();
  return _redis;
};

/** Admins are listed in the Redis set `admins` (tenant ids). */
export async function isAdmin(tenantId: string): Promise<boolean> {
  return (await redis().sismember("admins", tenantId)) === 1;
}

export type Day = {
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

const nums = (h: unknown): Record<string, number> =>
  Object.fromEntries(Object.entries((h as Record<string, unknown>) ?? {}).map(([k, v]) => [k, Number(v) || 0]));

const dateOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export async function loadMetrics(days: number): Promise<{ days: Day[]; first: Record<string, string> }> {
  const now = Date.now();
  const dates = Array.from({ length: days }, (_, i) => dateOf(now - i * 86_400_000));
  const p = redis().pipeline();
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
  p.hgetall("m:first");
  const r = (await p.exec()) as unknown[];
  const out = dates.map((date, i): Day => {
    const o = i * 9;
    const tokens = nums(r[o + 4]);
    return {
      date,
      active: ((r[o] as unknown[]) ?? []).map(String),
      turns: nums(r[o + 1]),
      tools: nums(r[o + 2]),
      toolErrors: nums(r[o + 3]),
      tokens: { in: tokens.in ?? 0, out: tokens.out ?? 0, calls: tokens.calls ?? 0 },
      latency: ((r[o + 5] as unknown[]) ?? []).map(Number).filter(Number.isFinite),
      errors: nums(r[o + 6]),
      shell: nums(r[o + 7]),
      spend: nums(r[o + 8]),
    };
  });
  const first = Object.fromEntries(
    Object.entries((r[dates.length * 9] as Record<string, unknown>) ?? {}).map(([k, v]) => [k, String(v)]),
  );
  return { days: out, first };
}

export const turnsOf = (d: Day) => (d.turns.telegram ?? 0) + (d.turns.imessage ?? 0);

export function percentile(values: number[], p: number): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

export const uniqueActive = (days: Day[]) => new Set(days.flatMap((d) => d.active)).size;

export function sumMaps(maps: Record<string, number>[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of maps) for (const [k, v] of Object.entries(m)) out[k] = (out[k] ?? 0) + v;
  return out;
}

/** Monday (UTC) of the week containing `date` (YYYY-MM-DD). */
export function weekOf(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7;
  return dateOf(d.getTime() - dow * 86_400_000);
}

export type Cohort = { week: string; size: number; returned: (number | null)[] };

/**
 * Weekly cohorts by first-active week: of each cohort, the share active in
 * each following week (null for weeks that haven't happened yet).
 */
export function retention(days: Day[], first: Record<string, string>, weeks = 8, horizon = 4): Cohort[] {
  const activeByWeek = new Map<string, Set<string>>();
  for (const d of days) {
    const w = weekOf(d.date);
    const set = activeByWeek.get(w) ?? new Set<string>();
    d.active.forEach((u) => set.add(u));
    activeByWeek.set(w, set);
  }
  const thisWeek = weekOf(dateOf(Date.now()));
  const cohorts: Cohort[] = [];
  for (let i = weeks - 1; i >= 0; i--) {
    const week = dateOf(Date.parse(`${thisWeek}T00:00:00Z`) - i * 7 * 86_400_000);
    const members = Object.entries(first).filter(([, d]) => weekOf(d) === week).map(([u]) => u);
    const returned = Array.from({ length: horizon }, (_, k) => {
      const later = dateOf(Date.parse(`${week}T00:00:00Z`) + (k + 1) * 7 * 86_400_000);
      if (later > thisWeek) return null;
      const active = activeByWeek.get(later) ?? new Set<string>();
      return members.length ? members.filter((u) => active.has(u)).length / members.length : 0;
    });
    cohorts.push({ week, size: members.length, returned });
  }
  return cohorts;
}
