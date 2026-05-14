import { Redis } from "@upstash/redis";

let _redis: Redis | null = null;
const getRedis = (): Redis => {
  if (!_redis) _redis = Redis.fromEnv();
  return _redis;
};

const k = (tenantId: string, ...parts: string[]): string =>
  `t:${tenantId}:${parts.join(":")}`;

const todayUTC = (): string => new Date().toISOString().slice(0, 10);

export type MealType = "breakfast" | "lunch" | "dinner" | "snack";

export type MealEntry = {
  text: string;
  kcal: number;
  protein_g?: number;
  carb_g?: number;
  fat_g?: number;
  meal_type?: MealType;
  logged_at: string;
};

export type DailyTotals = {
  kcal: number;
  protein_g: number;
  carb_g: number;
  fat_g: number;
  meal_count: number;
};

export type LogMealResult = {
  mealId: string;
  dailyKcal: number;
  date: string;
};

export async function logMeal(
  tenantId: string,
  entry: MealEntry,
): Promise<LogMealResult> {
  const mealId = crypto.randomUUID();
  const ts = Date.now();
  const date = todayUTC();

  const mealKey = k(tenantId, "meal", mealId);
  const indexKey = k(tenantId, "meals");
  const dailyKey = k(tenantId, "day", date);

  const pipe = getRedis().pipeline();
  pipe.hset(mealKey, {
    text: entry.text,
    kcal: Math.round(entry.kcal),
    protein_g: Math.round(entry.protein_g ?? 0),
    carb_g: Math.round(entry.carb_g ?? 0),
    fat_g: Math.round(entry.fat_g ?? 0),
    meal_type: entry.meal_type ?? "",
    logged_at: entry.logged_at,
  });
  pipe.zadd(indexKey, { score: ts, member: mealId });
  pipe.hincrby(dailyKey, "kcal", Math.round(entry.kcal));
  pipe.hincrby(dailyKey, "protein_g", Math.round(entry.protein_g ?? 0));
  pipe.hincrby(dailyKey, "carb_g", Math.round(entry.carb_g ?? 0));
  pipe.hincrby(dailyKey, "fat_g", Math.round(entry.fat_g ?? 0));
  pipe.hincrby(dailyKey, "meal_count", 1);
  const results = await pipe.exec();

  const dailyKcal = Number(results[2] ?? 0);
  return { mealId, dailyKcal, date };
}

export async function getDailyTotals(
  tenantId: string,
  date?: string,
): Promise<DailyTotals> {
  const d = date ?? todayUTC();
  const data =
    (await getRedis().hgetall<Record<string, string>>(k(tenantId, "day", d))) ??
    {};
  return {
    kcal: Number(data.kcal ?? 0),
    protein_g: Number(data.protein_g ?? 0),
    carb_g: Number(data.carb_g ?? 0),
    fat_g: Number(data.fat_g ?? 0),
    meal_count: Number(data.meal_count ?? 0),
  };
}

export type MealRecord = MealEntry & { id: string };

export async function getMealsByIds(
  tenantId: string,
  ids: string[],
): Promise<MealRecord[]> {
  if (ids.length === 0) return [];
  const pipe = getRedis().pipeline();
  for (const id of ids) pipe.hgetall(k(tenantId, "meal", id));
  const rows = await pipe.exec();
  return rows
    .map((row, i): MealRecord | null => {
      const r = row as Record<string, string> | null;
      if (!r || Object.keys(r).length === 0) return null;
      return {
        id: ids[i]!,
        text: r.text ?? "",
        kcal: Number(r.kcal ?? 0),
        protein_g: Number(r.protein_g ?? 0),
        carb_g: Number(r.carb_g ?? 0),
        fat_g: Number(r.fat_g ?? 0),
        meal_type: (r.meal_type || undefined) as MealType | undefined,
        logged_at: r.logged_at ?? "",
      };
    })
    .filter((m): m is MealRecord => m !== null);
}

export async function getMealsByDateRange(
  tenantId: string,
  fromTs: number,
  toTs: number,
  limit: number,
): Promise<MealRecord[]> {
  const ids = (await getRedis().zrange(k(tenantId, "meals"), fromTs, toTs, {
    byScore: true,
  })) as string[];
  ids.reverse();
  return getMealsByIds(tenantId, ids.slice(0, limit));
}

export async function getRecentMeals(
  tenantId: string,
  limit: number,
): Promise<MealRecord[]> {
  const ids = (await getRedis().zrange(k(tenantId, "meals"), 0, limit - 1, {
    rev: true,
  })) as string[];
  return getMealsByIds(tenantId, ids);
}

export { todayUTC };
