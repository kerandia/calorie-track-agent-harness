import { Redis } from "@upstash/redis";
import type {
  Assumption,
  DayTotals,
  Meal,
  MealType,
  UserProfile,
} from "./types";

// Read-only view into the SAME Upstash Redis the Flue agent writes to.
// Key schema mirrors .flue/lib/redis.ts: `t:{tenantId}:...`.

let _redis: Redis | null = null;
const redis = (): Redis => {
  if (!_redis) _redis = Redis.fromEnv();
  return _redis;
};

const k = (tenantId: string, ...parts: string[]): string =>
  `t:${tenantId}:${parts.join(":")}`;

const parseStringArray = (raw: string | undefined): string[] | undefined => {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : undefined;
  } catch {
    return undefined;
  }
};

function rowToMeal(id: string, r: Record<string, string>): Meal {
  return {
    id,
    text: r.text ?? "",
    kcal: Number(r.kcal ?? 0),
    protein_g: Number(r.protein_g ?? 0),
    carb_g: Number(r.carb_g ?? 0),
    fat_g: Number(r.fat_g ?? 0),
    meal_type: (r.meal_type as MealType) || undefined,
    logged_at: r.logged_at ?? "",
    feedback_sentiment:
      (r.feedback_sentiment as Meal["feedback_sentiment"]) || undefined,
    feedback_note: r.feedback_note || undefined,
  };
}

/** All meals for a tenant within [fromTs, toTs] (ms epoch), newest first. */
export async function getMealsInRange(
  tenantId: string,
  fromTs: number,
  toTs: number,
): Promise<Meal[]> {
  const ids = (await redis().zrange(k(tenantId, "meals"), fromTs, toTs, {
    byScore: true,
  })) as string[];
  if (ids.length === 0) return [];
  const pipe = redis().pipeline();
  for (const id of ids) pipe.hgetall(k(tenantId, "meal", id));
  const rows = await pipe.exec<(Record<string, string> | null)[]>();
  const meals: Meal[] = [];
  ids.forEach((id, i) => {
    const r = rows[i];
    if (r && Object.keys(r).length > 0) meals.push(rowToMeal(id, r));
  });
  meals.sort((a, b) => b.logged_at.localeCompare(a.logged_at));
  return meals;
}

/** Daily totals for a set of dates (YYYY-MM-DD). Missing days omitted. */
export async function getDayTotals(
  tenantId: string,
  dates: string[],
): Promise<Map<string, DayTotals>> {
  const out = new Map<string, DayTotals>();
  if (dates.length === 0) return out;
  const pipe = redis().pipeline();
  for (const d of dates) pipe.hgetall(k(tenantId, "day", d));
  const rows = await pipe.exec<(Record<string, string> | null)[]>();
  dates.forEach((d, i) => {
    const r = rows[i];
    if (r && Object.keys(r).length > 0) {
      out.set(d, {
        date: d,
        kcal: Number(r.kcal ?? 0),
        protein_g: Number(r.protein_g ?? 0),
        carb_g: Number(r.carb_g ?? 0),
        fat_g: Number(r.fat_g ?? 0),
        meal_count: Number(r.meal_count ?? 0),
      });
    }
  });
  return out;
}

/** Consume a one-time login token minted by the bot. Returns the tenant id
 * (telegram id) and deletes the token, or null if missing/expired. */
export async function consumeLoginToken(token: string): Promise<string | null> {
  if (!/^[a-f0-9]{16,64}$/.test(token)) return null;
  const key = `login:${token}`;
  const tenantId = await redis().get<string>(key);
  if (!tenantId) return null;
  await redis().del(key);
  return String(tenantId);
}

export async function getProfile(tenantId: string): Promise<UserProfile> {
  const r =
    (await redis().hgetall<Record<string, string>>(k(tenantId, "profile"))) ??
    {};
  const p: UserProfile = {};
  if (r.name) p.name = r.name;
  if (r.age) p.age = Number(r.age);
  if (r.sex) p.sex = r.sex as UserProfile["sex"];
  if (r.height_cm) p.height_cm = Number(r.height_cm);
  if (r.weight_kg) p.weight_kg = Number(r.weight_kg);
  if (r.activity_level)
    p.activity_level = r.activity_level as UserProfile["activity_level"];
  if (r.daily_kcal_goal) p.daily_kcal_goal = Number(r.daily_kcal_goal);
  p.dietary_preferences = parseStringArray(r.dietary_preferences);
  p.allergies = parseStringArray(r.allergies);
  p.likes = parseStringArray(r.likes);
  p.dislikes = parseStringArray(r.dislikes);
  if (r.onboarded_at) p.onboarded_at = r.onboarded_at;
  return p;
}

const ACTIVITY_FACTORS = {
  sedentary: 1.2,
  light: 1.375,
  moderate: 1.55,
  active: 1.725,
  very_active: 1.9,
} as const;

/** Mirrors the agent's computeKcalGoal (Mifflin-St Jeor + activity). */
export function computeKcalGoal(p: UserProfile): number | undefined {
  if (p.daily_kcal_goal && p.daily_kcal_goal > 0) return p.daily_kcal_goal;
  if (
    p.age === undefined ||
    p.sex === undefined ||
    p.height_cm === undefined ||
    p.weight_kg === undefined
  )
    return undefined;
  const base = 10 * p.weight_kg + 6.25 * p.height_cm - 5 * p.age;
  const bmr =
    p.sex === "male" ? base + 5 : p.sex === "female" ? base - 161 : base - 78;
  const factor = p.activity_level ? ACTIVITY_FACTORS[p.activity_level] : 1.4;
  return Math.round(bmr * factor);
}

export async function getActiveAssumptions(
  tenantId: string,
  limit = 20,
): Promise<Assumption[]> {
  const ids = (await redis().zrange(k(tenantId, "assumptions"), 0, limit - 1, {
    rev: true,
  })) as string[];
  if (ids.length === 0) return [];
  const pipe = redis().pipeline();
  for (const id of ids) pipe.hgetall(k(tenantId, "assumption", id));
  const rows = await pipe.exec<(Record<string, string> | null)[]>();
  const out: Assumption[] = [];
  ids.forEach((id, i) => {
    const r = rows[i];
    if (r && Object.keys(r).length > 0 && r.status !== "rejected") {
      out.push({
        id,
        text: r.text ?? "",
        confidence: (r.confidence as Assumption["confidence"]) ?? "medium",
        status: (r.status as Assumption["status"]) ?? "active",
        noted_at: r.noted_at ?? "",
      });
    }
  });
  return out;
}
