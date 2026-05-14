import { Index } from "@upstash/vector";

let _index: Index | null = null;
const getIndex = (): Index => {
  if (!_index) _index = Index.fromEnv();
  return _index;
};

export type MealMetadata = {
  text: string;
  kcal: number;
  meal_type?: string;
  logged_at: string;
  date: string;
};

export async function upsertMealVector(
  tenantId: string,
  mealId: string,
  text: string,
  metadata: MealMetadata,
): Promise<void> {
  await getIndex().namespace(tenantId).upsert({
    id: mealId,
    data: text,
    metadata: metadata as unknown as Record<string, unknown>,
  });
}

export type SemanticMatch = {
  id: string;
  score: number;
  metadata: MealMetadata;
};

export async function semanticSearchMeals(
  tenantId: string,
  query: string,
  topK: number,
): Promise<SemanticMatch[]> {
  const results = await getIndex().namespace(tenantId).query({
    data: query,
    topK,
    includeMetadata: true,
  });
  return results.map((r) => ({
    id: String(r.id),
    score: r.score,
    metadata: (r.metadata ?? {}) as unknown as MealMetadata,
  }));
}
