import type { FlueContext, ToolDef } from "@flue/runtime";
import { Type } from "@flue/runtime";
import * as v from "valibot";
import {
  getDailyTotals,
  getMealsByDateRange,
  getMealsByIds,
  getRecentMeals,
  logMeal,
  todayUTC,
  type MealRecord,
} from "../lib/redis.js";
import { semanticSearchMeals, upsertMealVector } from "../lib/vector.js";
import { createSessionBox, type SessionBox } from "../lib/box.js";

export const triggers = { webhook: true };

const InputSchema = v.object({
  tenantId: v.string(),
  text: v.string(),
  image: v.optional(
    v.object({
      base64: v.string(),
      mimeType: v.string(),
    }),
  ),
});

const formatMeals = (meals: MealRecord[]): string => {
  if (meals.length === 0) return "No meals found.";
  return meals
    .map((m, i) => {
      const kind = m.meal_type ? `, ${m.meal_type}` : "";
      return `${i + 1}. ${m.text} — ${m.kcal} kcal (${m.logged_at}${kind})`;
    })
    .join("\n");
};

const formatRun = (output: string, exit: number): string => {
  const trimmed = output.trim() || "(no output)";
  if (exit !== 0) return `exit ${exit}\n${trimmed}`;
  return trimmed;
};

export default async function chat({ init, payload }: FlueContext) {
  const input = v.parse(InputSchema, payload);
  const today = todayUTC();

  let _box: SessionBox | null = null;
  const getBox = async (): Promise<SessionBox> => {
    if (!_box) {
      console.log(`[chat] creating ephemeral box for ${input.tenantId}`);
      _box = await createSessionBox(input.tenantId);
    }
    return _box;
  };

  const logMealTool: ToolDef = {
    name: "log_meal",
    description:
      "Log a meal the user just ate. Use this whenever the user describes food they consumed. Estimate kcal and macros if the user didn't provide them.",
    parameters: Type.Object({
      text: Type.String({
        description:
          "Short description of what was eaten, e.g. 'a banana' or 'grilled chicken sandwich'.",
      }),
      kcal: Type.Number({ description: "Estimated calories. Whole number." }),
      protein_g: Type.Optional(
        Type.Number({ description: "Grams of protein. Whole number." }),
      ),
      carb_g: Type.Optional(
        Type.Number({ description: "Grams of carbs. Whole number." }),
      ),
      fat_g: Type.Optional(
        Type.Number({ description: "Grams of fat. Whole number." }),
      ),
      meal_type: Type.Optional(
        Type.Union(
          [
            Type.Literal("breakfast"),
            Type.Literal("lunch"),
            Type.Literal("dinner"),
            Type.Literal("snack"),
          ],
          { description: "Meal type if obvious from context." },
        ),
      ),
    }),
    execute: async (args) => {
      const loggedAt = new Date().toISOString();
      const r = await logMeal(input.tenantId, {
        text: args.text,
        kcal: args.kcal,
        protein_g: args.protein_g,
        carb_g: args.carb_g,
        fat_g: args.fat_g,
        meal_type: args.meal_type,
        logged_at: loggedAt,
      });
      try {
        await upsertMealVector(input.tenantId, r.mealId, args.text, {
          text: args.text,
          kcal: Math.round(args.kcal),
          meal_type: args.meal_type,
          logged_at: loggedAt,
          date: r.date,
        });
      } catch (err) {
        console.warn("[chat] vector upsert failed:", err);
      }
      return `Logged "${args.text}" (${Math.round(args.kcal)} kcal). Today's total: ${r.dailyKcal} kcal.`;
    },
  };

  const queryMealsTool: ToolDef = {
    name: "query_meals",
    description:
      "Search the user's logged meals. Use when the user asks what they ate, asks for history, or asks for similar foods. You can filter by date range and/or search semantically by text. If neither query nor dates are provided, returns the most recent meals.",
    parameters: Type.Object({
      query: Type.Optional(
        Type.String({
          description:
            "Free-text semantic search query, e.g. 'eggs' or 'protein-rich breakfast'. Omit if you only want a date filter or recent meals.",
        }),
      ),
      date_from: Type.Optional(
        Type.String({
          description:
            "Start date inclusive, YYYY-MM-DD format. For 'yesterday', compute from today's date.",
        }),
      ),
      date_to: Type.Optional(
        Type.String({
          description:
            "End date inclusive, YYYY-MM-DD format. For a single day, pass the same value as date_from.",
        }),
      ),
      limit: Type.Optional(
        Type.Number({ description: "Max number of results. Default 5." }),
      ),
    }),
    execute: async (args) => {
      const limit = args.limit ?? 5;
      const fromTs = args.date_from
        ? Date.parse(args.date_from + "T00:00:00.000Z")
        : 0;
      const toTs = args.date_to
        ? Date.parse(args.date_to + "T23:59:59.999Z")
        : Date.now();

      let meals: MealRecord[];

      if (args.query) {
        const matches = await semanticSearchMeals(
          input.tenantId,
          args.query,
          Math.max(limit * 3, 15),
        );
        const filtered =
          args.date_from || args.date_to
            ? matches.filter((m) => {
                const ts = Date.parse(m.metadata.logged_at);
                return ts >= fromTs && ts <= toTs;
              })
            : matches;
        const ids = filtered.slice(0, limit).map((m) => m.id);
        meals = await getMealsByIds(input.tenantId, ids);
      } else if (args.date_from || args.date_to) {
        meals = await getMealsByDateRange(input.tenantId, fromTs, toTs, limit);
      } else {
        meals = await getRecentMeals(input.tenantId, limit);
      }

      return formatMeals(meals);
    },
  };

  const getDailyTotalsTool: ToolDef = {
    name: "get_daily_totals",
    description:
      "Get the user's calorie and macro totals for a specific date. Use when the user asks 'how am I doing today' or 'what's my total'.",
    parameters: Type.Object({
      date: Type.Optional(
        Type.String({
          description: "Date to query (YYYY-MM-DD). Defaults to today.",
        }),
      ),
    }),
    execute: async (args) => {
      const totals = await getDailyTotals(input.tenantId, args.date);
      const d = args.date ?? today;
      if (totals.meal_count === 0) return `No meals logged for ${d}.`;
      const ms = totals.meal_count === 1 ? "meal" : "meals";
      return `${d}: ${totals.kcal} kcal across ${totals.meal_count} ${ms}. Protein ${totals.protein_g}g, carbs ${totals.carb_g}g, fat ${totals.fat_g}g.`;
    },
  };

  const runShellTool: ToolDef = {
    name: "run_shell",
    description:
      "Run a shell command inside a fresh Linux sandbox (python pre-installed, apk available for installs). Use for one-shot commands like 'pip install pandas', 'curl https://...', 'ls /workspace'. Returns stdout. Non-zero exit codes will be reported. The sandbox persists across tool calls within this turn.",
    parameters: Type.Object({
      cmd: Type.String({ description: "Shell command to execute." }),
    }),
    execute: async (args) => {
      const box = await getBox();
      const run = await box.exec.command(args.cmd);
      return formatRun(run.result ?? "", run.exitCode ?? 0);
    },
  };

  const runCodeTool: ToolDef = {
    name: "run_code",
    description:
      "Execute a Python, JS, or TS snippet inside the sandbox. Use for data analysis, computation, parsing, charts, or anything that needs more than a one-liner. Print results to stdout. The sandbox has TENANT_ID env var set; it does NOT have direct DB access — if you need the user's meal data, fetch it first with query_meals/get_daily_totals and pass it into the code as literals. Persists across tool calls within this turn.",
    parameters: Type.Object({
      language: Type.Union([
        Type.Literal("python"),
        Type.Literal("js"),
        Type.Literal("ts"),
      ]),
      code: Type.String({ description: "Code to execute." }),
    }),
    execute: async (args) => {
      const box = await getBox();
      const run = await box.exec.code({ lang: args.language, code: args.code });
      return formatRun(run.result ?? "", run.exitCode ?? 0);
    },
  };

  const harness = await init({
    model: "openrouter/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
    tools: [
      logMealTool,
      queryMealsTool,
      getDailyTotalsTool,
      runShellTool,
      runCodeTool,
    ],
  });
  const session = await harness.session(input.tenantId);

  const images = input.image
    ? [
        {
          type: "image" as const,
          data: input.image.base64,
          mimeType: input.image.mimeType,
        },
      ]
    : undefined;

  const userPart = input.image
    ? input.text.trim()
      ? `User (telegram id: ${input.tenantId}) sent an image with caption: "${input.text}"`
      : `User (telegram id: ${input.tenantId}) sent an image with no caption. Identify the food, estimate kcal/macros, and log it via log_meal.`
    : `User (telegram id: ${input.tenantId}) says: "${input.text}"`;

  try {
    const { data } = await session.prompt(
      `You are a concise, friendly calorie tracking assistant.\n\n` +
        `Today is ${today}.\n\n` +
        `You have access to the recent conversation with this user — use it. ` +
        `If the user refers to something from earlier ("that meal", "the photo I just sent", "my totals"), look at your prior turns first. ` +
        `For data you've never seen in this session (older meals, totals you haven't checked yet), use the tools to look it up.\n\n` +
        `If an image is attached, identify the food and call log_meal with your best kcal/macro estimate. ` +
        `If the image is not food, describe what you see briefly and skip logging.\n\n` +
        `Tools:\n` +
        `- log_meal: when the user describes food they ate (or sends a food image). Estimate kcal/macros if not provided.\n` +
        `- query_meals: when the user asks about ANY past meals.\n` +
        `- get_daily_totals: when the user asks about totals.\n` +
        `- run_shell(cmd): one-shot shell command in a Linux sandbox. Use for installs (pip/apk), curl, etc.\n` +
        `- run_code(language, code): run Python/JS/TS in the sandbox. Use for analysis, charts, parsing, multi-step computation. The sandbox has no direct DB access — fetch data via query_meals first, then pass it into the code.\n\n` +
        `Prefer the dedicated tools (log_meal, query_meals, get_daily_totals) for normal logging and lookups. ` +
        `Use the sandbox tools only when those don't fit (e.g. "compute my weekly average", "parse this recipe url", "estimate kcal from this nutrition label text").\n\n` +
        `For non-meal questions (greetings, advice), reply naturally without tools. Reply in 1-3 sentences.\n\n` +
        userPart,
      {
        result: v.object({
          reply: v.string(),
        }),
        images,
      },
    );
    return data;
  } finally {
    if (_box) {
      try {
        await _box.delete();
        console.log(`[chat] deleted ephemeral box`);
      } catch (err) {
        console.warn("[chat] box delete failed:", err);
      }
    }
  }
}
