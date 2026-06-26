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
  dateOverride?: string,
): Promise<LogMealResult> {
  const mealId = crypto.randomUUID();
  const date = dateOverride ?? todayUTC();
  const isToday = date === todayUTC();
  // For a past/explicit date, anchor the timestamp at noon UTC of that day so
  // date-range queries land it on the right day; for today, use the real now.
  const ts = isToday ? Date.now() : Date.parse(`${date}T12:00:00.000Z`);
  const loggedAt = isToday ? entry.logged_at : `${date}T12:00:00.000Z`;

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
    logged_at: loggedAt,
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

export type FeedbackSentiment = "good" | "neutral" | "bad";

export type MealRecord = MealEntry & {
  id: string;
  feedback_sentiment?: FeedbackSentiment;
  feedback_note?: string;
  feedback_at?: string;
};

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
        feedback_sentiment:
          (r.feedback_sentiment as FeedbackSentiment | undefined) || undefined,
        feedback_note: r.feedback_note || undefined,
        feedback_at: r.feedback_at || undefined,
      };
    })
    .filter((m): m is MealRecord => m !== null);
}

export async function recordMealFeedback(
  tenantId: string,
  mealId: string | null,
  sentiment: FeedbackSentiment,
  note?: string,
): Promise<{ mealId: string; text: string } | null> {
  let targetId = mealId;
  if (!targetId) {
    const recent = await getMostRecentMeal(tenantId);
    if (!recent) return null;
    targetId = recent.id;
  }
  const mealKey = k(tenantId, "meal", targetId);
  const existing = await getRedis().hgetall<Record<string, string>>(mealKey);
  if (!existing || Object.keys(existing).length === 0) return null;
  const fields: Record<string, string> = {
    feedback_sentiment: sentiment,
    feedback_at: new Date().toISOString(),
  };
  if (note) fields.feedback_note = note;
  await getRedis().hset(mealKey, fields);
  return { mealId: targetId, text: existing.text ?? "" };
}

export async function getMealsAwaitingFeedback(
  tenantId: string,
  minAgeMs: number,
  maxAgeMs: number,
  limit = 3,
): Promise<MealRecord[]> {
  const now = Date.now();
  const fromTs = now - maxAgeMs;
  const toTs = now - minAgeMs;
  if (toTs <= fromTs) return [];
  const ids = (await getRedis().zrange(k(tenantId, "meals"), fromTs, toTs, {
    byScore: true,
  })) as string[];
  ids.reverse();
  const meals = await getMealsByIds(tenantId, ids);
  return meals
    .filter((m) => !m.feedback_sentiment)
    .slice(0, limit);
}

export type AssumptionConfidence = "low" | "medium" | "high";
export type AssumptionStatus = "active" | "confirmed" | "rejected";

export type AssumptionRecord = {
  id: string;
  text: string;
  confidence: AssumptionConfidence;
  status: AssumptionStatus;
  source_run_id?: string;
  noted_at: string;
  updated_at?: string;
};

const shortId = (): string => crypto.randomUUID().split("-")[0]!;

export async function noteAssumption(
  tenantId: string,
  text: string,
  confidence: AssumptionConfidence,
  sourceRunId?: string,
): Promise<string> {
  const id = shortId();
  const noted_at = new Date().toISOString();
  const ts = Date.parse(noted_at);
  const hashKey = k(tenantId, "assumption", id);
  const fields: Record<string, string> = {
    text,
    confidence,
    status: "active",
    noted_at,
  };
  if (sourceRunId) fields.source_run_id = sourceRunId;
  const pipe = getRedis().pipeline();
  pipe.hset(hashKey, fields);
  pipe.zadd(k(tenantId, "assumptions"), { score: ts, member: id });
  await pipe.exec();
  return id;
}

export async function getActiveAssumptions(
  tenantId: string,
  limit = 5,
): Promise<AssumptionRecord[]> {
  const ids = (await getRedis().zrange(
    k(tenantId, "assumptions"),
    0,
    limit * 3 - 1,
    { rev: true },
  )) as string[];
  if (ids.length === 0) return [];
  const pipe = getRedis().pipeline();
  for (const id of ids) pipe.hgetall(k(tenantId, "assumption", id));
  const rows = await pipe.exec();
  return rows
    .map((row, i): AssumptionRecord | null => {
      const r = row as Record<string, string> | null;
      if (!r || Object.keys(r).length === 0) return null;
      return {
        id: ids[i]!,
        text: r.text ?? "",
        confidence: (r.confidence as AssumptionConfidence) ?? "medium",
        status: (r.status as AssumptionStatus) ?? "active",
        source_run_id: r.source_run_id || undefined,
        noted_at: r.noted_at ?? "",
        updated_at: r.updated_at || undefined,
      };
    })
    .filter((a): a is AssumptionRecord => a !== null && a.status === "active")
    .slice(0, limit);
}

export async function updateAssumptionStatus(
  tenantId: string,
  id: string,
  status: AssumptionStatus,
): Promise<AssumptionRecord | null> {
  const hashKey = k(tenantId, "assumption", id);
  const existing = await getRedis().hgetall<Record<string, string>>(hashKey);
  if (!existing || Object.keys(existing).length === 0) return null;
  await getRedis().hset(hashKey, {
    status,
    updated_at: new Date().toISOString(),
  });
  return {
    id,
    text: existing.text ?? "",
    confidence: (existing.confidence as AssumptionConfidence) ?? "medium",
    status,
    source_run_id: existing.source_run_id || undefined,
    noted_at: existing.noted_at ?? "",
    updated_at: new Date().toISOString(),
  };
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

export async function getMostRecentMeal(
  tenantId: string,
): Promise<MealRecord | null> {
  const records = await getRecentMeals(tenantId, 1);
  return records[0] ?? null;
}

export type UpdateMealPatch = {
  text?: string;
  kcal?: number;
  protein_g?: number;
  carb_g?: number;
  fat_g?: number;
  meal_type?: MealType;
  /** Move the meal to this date (YYYY-MM-DD). Adjusts totals on both days. */
  date?: string;
};

export type UpdateMealResult = {
  mealId: string;
  date: string;
  movedFrom?: string;
  oldKcal: number;
  newKcal: number;
  dailyKcal: number;
  text: string;
};

/** Resolve "recent" (or null) to the most-recent meal id, else use the id. */
export async function resolveMealId(
  tenantId: string,
  mealId: string | null,
): Promise<string | null> {
  if (mealId && mealId !== "recent") return mealId;
  const recent = await getMostRecentMeal(tenantId);
  return recent?.id ?? null;
}

export async function updateMealById(
  tenantId: string,
  mealId: string,
  patch: UpdateMealPatch,
): Promise<UpdateMealResult | null> {
  const [existing] = await getMealsByIds(tenantId, [mealId]);
  if (!existing) return null;

  const oldDate = existing.logged_at.slice(0, 10);
  const newDate = patch.date ?? oldDate;
  const moving = newDate !== oldDate;

  const exP = existing.protein_g ?? 0;
  const exC = existing.carb_g ?? 0;
  const exF = existing.fat_g ?? 0;

  const merged = {
    text: patch.text ?? existing.text,
    kcal: Math.round(patch.kcal ?? existing.kcal),
    protein_g: Math.round(patch.protein_g ?? exP),
    carb_g: Math.round(patch.carb_g ?? exC),
    fat_g: Math.round(patch.fat_g ?? exF),
    meal_type: patch.meal_type ?? existing.meal_type,
  };

  const mealKey = k(tenantId, "meal", mealId);
  const pipe = getRedis().pipeline();

  if (moving) {
    // Remove the meal's full nutrition from the old day, add to the new day.
    const oldDaily = k(tenantId, "day", oldDate);
    const newDaily = k(tenantId, "day", newDate);
    if (existing.kcal) pipe.hincrby(oldDaily, "kcal", -existing.kcal);
    if (exP) pipe.hincrby(oldDaily, "protein_g", -exP);
    if (exC) pipe.hincrby(oldDaily, "carb_g", -exC);
    if (exF) pipe.hincrby(oldDaily, "fat_g", -exF);
    pipe.hincrby(oldDaily, "meal_count", -1);
    if (merged.kcal) pipe.hincrby(newDaily, "kcal", merged.kcal);
    if (merged.protein_g) pipe.hincrby(newDaily, "protein_g", merged.protein_g);
    if (merged.carb_g) pipe.hincrby(newDaily, "carb_g", merged.carb_g);
    if (merged.fat_g) pipe.hincrby(newDaily, "fat_g", merged.fat_g);
    pipe.hincrby(newDaily, "meal_count", 1);
    const newTs = Date.parse(`${newDate}T12:00:00.000Z`);
    pipe.zadd(k(tenantId, "meals"), { score: newTs, member: mealId });
    pipe.hset(mealKey, {
      text: merged.text,
      kcal: merged.kcal,
      protein_g: merged.protein_g,
      carb_g: merged.carb_g,
      fat_g: merged.fat_g,
      meal_type: merged.meal_type ?? "",
      logged_at: `${newDate}T12:00:00.000Z`,
    });
  } else {
    const dailyKey = k(tenantId, "day", oldDate);
    pipe.hset(mealKey, {
      text: merged.text,
      kcal: merged.kcal,
      protein_g: merged.protein_g,
      carb_g: merged.carb_g,
      fat_g: merged.fat_g,
      meal_type: merged.meal_type ?? "",
    });
    const dKcal = merged.kcal - existing.kcal;
    if (dKcal !== 0) pipe.hincrby(dailyKey, "kcal", dKcal);
    if (merged.protein_g - exP !== 0)
      pipe.hincrby(dailyKey, "protein_g", merged.protein_g - exP);
    if (merged.carb_g - exC !== 0)
      pipe.hincrby(dailyKey, "carb_g", merged.carb_g - exC);
    if (merged.fat_g - exF !== 0)
      pipe.hincrby(dailyKey, "fat_g", merged.fat_g - exF);
  }
  await pipe.exec();

  const dailyKcalRaw = await getRedis().hget<string>(
    k(tenantId, "day", newDate),
    "kcal",
  );
  return {
    mealId,
    date: newDate,
    movedFrom: moving ? oldDate : undefined,
    oldKcal: existing.kcal,
    newKcal: merged.kcal,
    dailyKcal: Number(dailyKcalRaw ?? merged.kcal),
    text: merged.text,
  };
}

export type DeleteMealResult = {
  mealId: string;
  text: string;
  kcalRemoved: number;
  date: string;
};

export async function deleteMealById(
  tenantId: string,
  mealId: string,
): Promise<DeleteMealResult | null> {
  const [existing] = await getMealsByIds(tenantId, [mealId]);
  if (!existing) return null;

  const date = existing.logged_at.slice(0, 10);
  const dailyKey = k(tenantId, "day", date);
  const mealKey = k(tenantId, "meal", existing.id);
  const indexKey = k(tenantId, "meals");

  const protein = existing.protein_g ?? 0;
  const carb = existing.carb_g ?? 0;
  const fat = existing.fat_g ?? 0;

  const pipe = getRedis().pipeline();
  pipe.del(mealKey);
  pipe.zrem(indexKey, existing.id);
  if (existing.kcal !== 0) pipe.hincrby(dailyKey, "kcal", -existing.kcal);
  if (protein !== 0) pipe.hincrby(dailyKey, "protein_g", -protein);
  if (carb !== 0) pipe.hincrby(dailyKey, "carb_g", -carb);
  if (fat !== 0) pipe.hincrby(dailyKey, "fat_g", -fat);
  pipe.hincrby(dailyKey, "meal_count", -1);
  await pipe.exec();

  return {
    mealId: existing.id,
    text: existing.text,
    kcalRemoved: existing.kcal,
    date,
  };
}

export type Sex = "male" | "female" | "other";
export type ActivityLevel =
  | "sedentary"
  | "light"
  | "moderate"
  | "active"
  | "very_active";

export type UserProfile = {
  name?: string;
  age?: number;
  sex?: Sex;
  height_cm?: number;
  weight_kg?: number;
  activity_level?: ActivityLevel;
  daily_kcal_goal?: number;
  dietary_preferences?: string[];
  allergies?: string[];
  likes?: string[];
  dislikes?: string[];
  timezone?: string;
  onboarded_at?: string;
};

const REQUIRED_PROFILE_FIELDS = [
  "name",
  "age",
  "sex",
  "height_cm",
  "weight_kg",
] as const satisfies readonly (keyof UserProfile)[];

const ACTIVITY_FACTORS: Record<ActivityLevel, number> = {
  sedentary: 1.2,
  light: 1.375,
  moderate: 1.55,
  active: 1.725,
  very_active: 1.9,
};

const parseStringArray = (raw: string | undefined): string[] | undefined => {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : undefined;
  } catch {
    return undefined;
  }
};

export async function getProfile(tenantId: string): Promise<UserProfile> {
  const raw =
    (await getRedis().hgetall<Record<string, string>>(
      k(tenantId, "profile"),
    )) ?? {};
  const profile: UserProfile = {};
  if (raw.name) profile.name = raw.name;
  if (raw.age) profile.age = Number(raw.age);
  if (raw.sex) profile.sex = raw.sex as Sex;
  if (raw.height_cm) profile.height_cm = Number(raw.height_cm);
  if (raw.weight_kg) profile.weight_kg = Number(raw.weight_kg);
  if (raw.activity_level)
    profile.activity_level = raw.activity_level as ActivityLevel;
  if (raw.daily_kcal_goal)
    profile.daily_kcal_goal = Number(raw.daily_kcal_goal);
  profile.dietary_preferences = parseStringArray(raw.dietary_preferences);
  profile.allergies = parseStringArray(raw.allergies);
  profile.likes = parseStringArray(raw.likes);
  profile.dislikes = parseStringArray(raw.dislikes);
  if (raw.timezone) profile.timezone = raw.timezone;
  if (raw.onboarded_at) profile.onboarded_at = raw.onboarded_at;
  return profile;
}

export async function updateProfile(
  tenantId: string,
  patch: Partial<UserProfile>,
): Promise<UserProfile> {
  const flat: Record<string, string | number> = {};
  if (patch.name !== undefined) flat.name = patch.name;
  if (patch.age !== undefined) flat.age = patch.age;
  if (patch.sex !== undefined) flat.sex = patch.sex;
  if (patch.height_cm !== undefined) flat.height_cm = patch.height_cm;
  if (patch.weight_kg !== undefined) flat.weight_kg = patch.weight_kg;
  if (patch.activity_level !== undefined)
    flat.activity_level = patch.activity_level;
  if (patch.daily_kcal_goal !== undefined)
    flat.daily_kcal_goal = patch.daily_kcal_goal;
  if (patch.dietary_preferences !== undefined)
    flat.dietary_preferences = JSON.stringify(patch.dietary_preferences);
  if (patch.allergies !== undefined)
    flat.allergies = JSON.stringify(patch.allergies);
  if (patch.likes !== undefined) flat.likes = JSON.stringify(patch.likes);
  if (patch.dislikes !== undefined)
    flat.dislikes = JSON.stringify(patch.dislikes);
  if (patch.timezone !== undefined) flat.timezone = patch.timezone;
  if (patch.onboarded_at !== undefined) flat.onboarded_at = patch.onboarded_at;

  const profileKey = k(tenantId, "profile");
  if (Object.keys(flat).length > 0) {
    await getRedis().hset(profileKey, flat);
  }

  const current = await getProfile(tenantId);
  if (
    !current.onboarded_at &&
    REQUIRED_PROFILE_FIELDS.every(
      (f) => current[f] !== undefined && current[f] !== "",
    )
  ) {
    const stamp = new Date().toISOString();
    await getRedis().hset(profileKey, { onboarded_at: stamp });
    current.onboarded_at = stamp;
  }
  return current;
}

export function isOnboarded(profile: UserProfile): boolean {
  return !!profile.onboarded_at;
}

export function getMissingRequiredFields(
  profile: UserProfile,
): readonly string[] {
  return REQUIRED_PROFILE_FIELDS.filter((f) => profile[f] === undefined);
}

export function computeKcalGoal(profile: UserProfile): number | undefined {
  if (profile.daily_kcal_goal && profile.daily_kcal_goal > 0) {
    return profile.daily_kcal_goal;
  }
  if (
    profile.age === undefined ||
    profile.sex === undefined ||
    profile.height_cm === undefined ||
    profile.weight_kg === undefined
  ) {
    return undefined;
  }
  const base =
    10 * profile.weight_kg + 6.25 * profile.height_cm - 5 * profile.age;
  const bmr =
    profile.sex === "male"
      ? base + 5
      : profile.sex === "female"
        ? base - 161
        : base - 78;
  const factor = profile.activity_level
    ? ACTIVITY_FACTORS[profile.activity_level]
    : 1.4;
  return Math.round(bmr * factor);
}

export function summarizeProfile(profile: UserProfile): string {
  const parts: string[] = [];
  const demo: string[] = [];
  if (profile.name) demo.push(profile.name);
  if (profile.age !== undefined) demo.push(`${profile.age}yo`);
  if (profile.sex) demo.push(profile.sex);
  if (profile.height_cm !== undefined) demo.push(`${profile.height_cm}cm`);
  if (profile.weight_kg !== undefined) demo.push(`${profile.weight_kg}kg`);
  if (demo.length) parts.push(demo.join(" "));
  if (profile.activity_level) parts.push(`${profile.activity_level} activity`);
  const goal = computeKcalGoal(profile);
  if (goal) parts.push(`~${goal} kcal/day target`);
  if (profile.allergies?.length)
    parts.push(`allergies: ${profile.allergies.join(", ")}`);
  if (profile.dietary_preferences?.length)
    parts.push(`diet: ${profile.dietary_preferences.join(", ")}`);
  if (profile.dislikes?.length)
    parts.push(`dislikes: ${profile.dislikes.join(", ")}`);
  if (profile.likes?.length) parts.push(`likes: ${profile.likes.join(", ")}`);
  return parts.join("; ");
}

export { todayUTC };
