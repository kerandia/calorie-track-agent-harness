import type { FlueContext, ToolDef } from "@flue/runtime";
import { Type } from "@flue/runtime";
import * as v from "valibot";
import {
  deleteMealById,
  getActiveAssumptions,
  getDailyTotals,
  getMealsAwaitingFeedback,
  getMealsByDateRange,
  getMealsByIds,
  getMissingRequiredFields,
  getMostRecentMeal,
  getProfile,
  getRecentMeals,
  getRecentPhotos,
  isOnboarded,
  logMeal,
  noteAssumption,
  recordMealFeedback,
  rememberPhotos,
  resolveMealId,
  summarizeProfile,
  todayUTC,
  updateAssumptionStatus,
  updateMealById,
  updateProfile,
  type MealRecord,
  type PhotoMemory,
} from "../lib/redis.js";
import {
  deleteMealVector,
  semanticSearchMeals,
  upsertMealVector,
} from "../lib/vector.js";
import { createSessionBox, type SessionBox } from "../lib/box.js";
import { describeImage } from "../lib/vision.js";
import { redisSessionStore } from "../lib/sessionStore.js";
import {
  DEFAULT_VISION_FALLBACK_MODEL,
  MAIN_MODEL,
} from "../lib/models.js";

export const triggers = { webhook: true };

const ImageSchema = v.object({
  base64: v.string(),
  mimeType: v.string(),
});

// One agent turn = one coalesced burst from the user: some text (possibly
// several messages joined), zero or more photos, maybe a voice note.
const InputSchema = v.object({
  tenantId: v.string(),
  text: v.string(),
  /** Legacy single-image shape (still sent by the local long-polling bot). */
  image: v.optional(ImageSchema),
  images: v.optional(v.array(ImageSchema)),
  voice: v.optional(v.boolean()),
  /** Photos in the burst beyond the per-turn cap — not analyzed. */
  photosDropped: v.optional(v.number()),
});

/** Local wall-clock for the user, if we know their timezone. */
const formatLocalTime = (d: Date, tz?: string): string | undefined => {
  if (!tz) return undefined;
  try {
    const s = new Intl.DateTimeFormat("en-GB", {
      timeZone: tz,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(d);
    return `${s} ${tz}`;
  } catch {
    return undefined;
  }
};

const formatElapsed = (seconds: number): string => {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60 ? ` ${m % 60}m` : ""}`;
};

const formatMeals = (meals: MealRecord[]): string => {
  if (meals.length === 0) return "No meals found.";
  return meals
    .map((m, i) => {
      const kind = m.meal_type ? `, ${m.meal_type}` : "";
      const day = m.logged_at.slice(0, 10);
      return `${i + 1}. ${m.text} — ${m.kcal} kcal (${day}${kind}) [id: ${m.id}]`;
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

  const boxRef: { current: SessionBox | null } = { current: null };
  const getBox = async (): Promise<SessionBox> => {
    if (!boxRef.current) {
      console.log(`[chat] creating ephemeral box for ${input.tenantId}`);
      boxRef.current = await createSessionBox(input.tenantId);
    }
    return boxRef.current;
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
      date: Type.Optional(
        Type.String({
          description:
            "Date this meal was eaten, YYYY-MM-DD. ONLY set this when the user says the meal was on a day OTHER than today (e.g. 'yesterday', 'on Monday'). Omit for meals eaten today. Compute the concrete date from today's date in context.",
        }),
      ),
    }),
    execute: async (args) => {
      const loggedAt = new Date().toISOString();
      const r = await logMeal(
        input.tenantId,
        {
          text: args.text,
          kcal: args.kcal,
          protein_g: args.protein_g,
          carb_g: args.carb_g,
          fat_g: args.fat_g,
          meal_type: args.meal_type,
          logged_at: loggedAt,
        },
        args.date,
      );
      try {
        await upsertMealVector(input.tenantId, r.mealId, args.text, {
          text: args.text,
          kcal: Math.round(args.kcal),
          meal_type: args.meal_type,
          logged_at: r.date === today ? loggedAt : `${r.date}T12:00:00.000Z`,
          date: r.date,
        });
      } catch (err) {
        console.warn("[chat] vector upsert failed:", err);
      }
      const dayLabel = r.date === today ? "Today's" : `${r.date}`;
      return `Logged "${args.text}" (${Math.round(args.kcal)} kcal, id: ${r.mealId}) on ${r.date}. ${dayLabel} total: ${r.dailyKcal} kcal.`;
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

  const recordFeedbackTool: ToolDef = {
    name: "record_feedback",
    description:
      "Record how the user felt after a specific meal. Use AFTER the user answers a 'how did you feel?' follow-up. Pass meal_id 'recent' to attach to the most recently logged meal, or the actual id returned by log_meal.",
    parameters: Type.Object({
      meal_id: Type.String({
        description: "Meal id from log_meal, or the literal string 'recent'.",
      }),
      sentiment: Type.Union([
        Type.Literal("good"),
        Type.Literal("neutral"),
        Type.Literal("bad"),
      ]),
      note: Type.Optional(
        Type.String({ description: "Brief reason or symptoms." }),
      ),
    }),
    execute: async (args) => {
      const targetId = args.meal_id === "recent" ? null : args.meal_id;
      const r = await recordMealFeedback(
        input.tenantId,
        targetId,
        args.sentiment,
        args.note,
      );
      if (!r) return "No meal found to attach feedback to.";
      return `Feedback recorded for "${r.text}": ${args.sentiment}${args.note ? ` — ${args.note}` : ""}.`;
    },
  };

  const noteAssumptionTool: ToolDef = {
    name: "note_assumption",
    description:
      "Record an INFERENCE about the user that goes beyond their explicit profile (e.g. 'tends to skip breakfast on weekdays', 'feels better on high-protein meals', 'is in a cutting phase'). For explicit facts like allergies, preferences, goals — use update_profile instead. One assumption per call.",
    parameters: Type.Object({
      text: Type.String({
        description: "One sentence describing the inference.",
      }),
      confidence: Type.Union([
        Type.Literal("low"),
        Type.Literal("medium"),
        Type.Literal("high"),
      ]),
    }),
    execute: async (args) => {
      const id = await noteAssumption(
        input.tenantId,
        args.text,
        args.confidence,
      );
      return `Assumption #${id} recorded: "${args.text}" [${args.confidence}].`;
    },
  };

  const updateAssumptionStatusTool: ToolDef = {
    name: "update_assumption_status",
    description:
      "Mark a previously-noted assumption as 'confirmed' (user agreed) or 'rejected' (user pushed back). Use when the user reacts to an assumption you've stated or that's listed in the context.",
    parameters: Type.Object({
      id: Type.String({ description: "The assumption id, e.g. 'a1b2c3d4'." }),
      status: Type.Union([
        Type.Literal("confirmed"),
        Type.Literal("rejected"),
      ]),
    }),
    execute: async (args) => {
      const r = await updateAssumptionStatus(
        input.tenantId,
        args.id,
        args.status,
      );
      if (!r) return `No assumption with id ${args.id} found.`;
      return `Marked assumption "${r.text}" as ${args.status}.`;
    },
  };

  const updateProfileTool: ToolDef = {
    name: "update_profile",
    description:
      "Update the user's profile. Use during onboarding to capture demographics/preferences AND any time during normal conversation when the user reveals something new about themselves ('I'm vegan now', 'I'm allergic to peanuts', 'my goal is 1800 kcal'). Pass only the fields being set or changed.",
    parameters: Type.Object({
      name: Type.Optional(Type.String()),
      age: Type.Optional(Type.Number()),
      sex: Type.Optional(
        Type.Union([
          Type.Literal("male"),
          Type.Literal("female"),
          Type.Literal("other"),
        ]),
      ),
      height_cm: Type.Optional(Type.Number()),
      weight_kg: Type.Optional(Type.Number()),
      activity_level: Type.Optional(
        Type.Union([
          Type.Literal("sedentary"),
          Type.Literal("light"),
          Type.Literal("moderate"),
          Type.Literal("active"),
          Type.Literal("very_active"),
        ]),
      ),
      daily_kcal_goal: Type.Optional(
        Type.Number({
          description:
            "Explicit daily calorie target. Omit to let the system auto-compute from age/sex/height/weight/activity (Mifflin-St Jeor).",
        }),
      ),
      dietary_preferences: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "e.g. ['vegan'], ['keto'], ['mediterranean']. Empty array clears.",
        }),
      ),
      allergies: Type.Optional(
        Type.Array(Type.String(), {
          description: "e.g. ['gluten', 'nuts']. Empty array clears.",
        }),
      ),
      likes: Type.Optional(Type.Array(Type.String())),
      dislikes: Type.Optional(Type.Array(Type.String())),
      timezone: Type.Optional(
        Type.String({
          description:
            "IANA timezone like 'Europe/Berlin' or 'Europe/Istanbul'. Set when the user says where they live or what their local time is.",
        }),
      ),
    }),
    execute: async (args) => {
      const updated = await updateProfile(input.tenantId, args);
      const summary = summarizeProfile(updated);
      const justOnboarded =
        !onboarded && isOnboarded(updated)
          ? " User has just completed onboarding."
          : "";
      return `Profile updated. Current: ${summary || "(empty)"}.${justOnboarded}`;
    },
  };

  const getProfileTool: ToolDef = {
    name: "get_profile",
    description:
      "Get the user's current profile (name, demographics, preferences, allergies, kcal target). Use when the user asks what you know about them, or before personalizing a recommendation.",
    parameters: Type.Object({}),
    execute: async () => {
      const p = await getProfile(input.tenantId);
      return summarizeProfile(p) || "Profile is empty.";
    },
  };

  const updateMealTool: ToolDef = {
    name: "update_meal",
    description:
      "Edit a logged meal: fix its description/calories/macros, OR move it to a different day. " +
      "Pass meal_id 'recent' for the meal you just logged, or an actual id from log_meal / query_meals. " +
      "To MOVE a meal to another day (e.g. user says 'that was yesterday, not today'), set `date` — totals on both days are corrected automatically. " +
      "Only pass the fields that change; keep the meal's identity (don't rewrite the food unless the user is correcting what it was).",
    parameters: Type.Object({
      meal_id: Type.String({
        description: "Meal id from log_meal/query_meals, or 'recent'.",
      }),
      text: Type.Optional(
        Type.String({ description: "Corrected food description." }),
      ),
      kcal: Type.Optional(
        Type.Number({ description: "Corrected calories (whole number)." }),
      ),
      protein_g: Type.Optional(Type.Number()),
      carb_g: Type.Optional(Type.Number()),
      fat_g: Type.Optional(Type.Number()),
      meal_type: Type.Optional(
        Type.Union([
          Type.Literal("breakfast"),
          Type.Literal("lunch"),
          Type.Literal("dinner"),
          Type.Literal("snack"),
        ]),
      ),
      date: Type.Optional(
        Type.String({
          description:
            "Move the meal to this day (YYYY-MM-DD). Use when the user says it was on a different day.",
        }),
      ),
    }),
    execute: async (args) => {
      const id = await resolveMealId(input.tenantId, args.meal_id);
      if (!id) return "No meal found to update.";
      const r = await updateMealById(input.tenantId, id, {
        text: args.text,
        kcal: args.kcal,
        protein_g: args.protein_g,
        carb_g: args.carb_g,
        fat_g: args.fat_g,
        meal_type: args.meal_type,
        date: args.date,
      });
      if (!r) return "No meal found to update.";
      if (args.text || args.date) {
        try {
          await upsertMealVector(input.tenantId, r.mealId, r.text, {
            text: r.text,
            kcal: r.newKcal,
            meal_type: args.meal_type,
            logged_at: `${r.date}T12:00:00.000Z`,
            date: r.date,
          });
        } catch (err) {
          console.warn("[chat] vector reupsert failed:", err);
        }
      }
      const moved = r.movedFrom ? ` (moved ${r.movedFrom} → ${r.date})` : "";
      return `Updated "${r.text}"${moved}. ${r.date} total: ${r.dailyKcal} kcal.`;
    },
  };

  const deleteMealTool: ToolDef = {
    name: "delete_meal",
    description:
      "Delete a logged meal. Pass meal_id 'recent' for the meal you just logged, or an actual id from query_meals. " +
      "Use when the user says 'that wasn't food', 'I didn't eat that', 'remove it', or 'undo'.",
    parameters: Type.Object({
      meal_id: Type.String({
        description: "Meal id from log_meal/query_meals, or 'recent'.",
      }),
    }),
    execute: async (args) => {
      const id = await resolveMealId(input.tenantId, args.meal_id);
      if (!id) return "Nothing to delete.";
      const r = await deleteMealById(input.tenantId, id);
      if (!r) return "Nothing to delete.";
      try {
        await deleteMealVector(input.tenantId, r.mealId);
      } catch (err) {
        console.warn("[chat] vector delete failed:", err);
      }
      return `Deleted "${r.text}" (${r.kcalRemoved} kcal removed from ${r.date}).`;
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
    model: MAIN_MODEL,
    // Sezo's persona and standing rules live in .flue/roles/sezo.md and ride
    // in the SYSTEM prompt. They used to be prepended to every user message,
    // so the transcript was ~90% repeated instructions and the model kept
    // losing what the user had actually sent a few turns earlier.
    role: "sezo",
    persist: redisSessionStore,
    tools: [
      logMealTool,
      updateMealTool,
      deleteMealTool,
      queryMealsTool,
      getDailyTotalsTool,
      recordFeedbackTool,
      noteAssumptionTool,
      updateAssumptionStatusTool,
      updateProfileTool,
      getProfileTool,
      runShellTool,
      runCodeTool,
    ],
  });
  const session = await harness.session(input.tenantId);

  // ── Photos in this burst: describe all of them in parallel ───────────────
  const images = [
    ...(input.images ?? []),
    ...(input.image ? [input.image] : []),
  ];
  const fallbackVisionModel =
    process.env.VISION_MODEL ?? DEFAULT_VISION_FALLBACK_MODEL;
  const visions = await Promise.all(
    images.map(async (img, i) => {
      try {
        const vision = await describeImage(img, {
          caption: input.text,
          fallbackModel: fallbackVisionModel,
        });
        console.log(
          `[chat] vision ${i + 1}/${images.length} (${vision.model}) [${vision.kind}]: ${vision.description.slice(0, 120)}`,
        );
        return vision;
      } catch (err) {
        console.warn(`[chat] vision ${i + 1}/${images.length} failed:`, err);
        return null;
      }
    }),
  );

  const profile = await getProfile(input.tenantId);
  const profileSummary = summarizeProfile(profile);
  const onboarded = isOnboarded(profile);
  const missingFields = getMissingRequiredFields(profile);

  const now = new Date();

  // Photo memory: read BEFORE storing this turn's photos, so the list is
  // strictly "photos from earlier" and this turn's are presented separately.
  let earlierPhotos: PhotoMemory[] = [];
  try {
    earlierPhotos = await getRecentPhotos(input.tenantId, 48 * 60 * 60 * 1000, 6);
  } catch (err) {
    console.warn("[chat] photo memory fetch failed:", err);
  }
  const newPhotoMemories: PhotoMemory[] = visions.flatMap((vis) =>
    vis
      ? [
          {
            at: now.toISOString(),
            kind: vis.kind,
            description: vis.description,
            caption: input.text.trim() || undefined,
          },
        ]
      : [],
  );
  if (newPhotoMemories.length > 0) {
    try {
      await rememberPhotos(input.tenantId, newPhotoMemories);
    } catch (err) {
      console.warn("[chat] photo memory store failed:", err);
    }
  }

  let recentContext = "";
  try {
    const recent = await getMostRecentMeal(input.tenantId);
    if (recent?.logged_at) {
      const elapsedMs = now.getTime() - Date.parse(recent.logged_at);
      if (elapsedMs >= 0 && elapsedMs < 24 * 60 * 60 * 1000) {
        const elapsed = formatElapsed(Math.floor(elapsedMs / 1000));
        recentContext =
          `Database: the most recently LOGGED meal is "${recent.text}" (${recent.kcal} kcal, id ${recent.id}), logged ${elapsed} ago. ` +
          `That is a DB record, not the last thing the user sent you — the conversation and the photo memory tell you that.`;
        if (elapsedMs < 180 * 1000) {
          recentContext +=
            ` It was logged JUST NOW: if this message restates, refines, or breaks down that same item (ingredients, a different name, portion tweak), call update_meal with meal_id "recent" — do NOT log a new meal.`;
        }
      }
    }
  } catch (err) {
    console.warn("[chat] recent-meal context fetch failed:", err);
  }

  let pendingFeedback: MealRecord[] = [];
  let activeAssumptions: Awaited<ReturnType<typeof getActiveAssumptions>> = [];
  try {
    [pendingFeedback, activeAssumptions] = await Promise.all([
      getMealsAwaitingFeedback(
        input.tenantId,
        15 * 60 * 1000,
        12 * 60 * 60 * 1000,
        1,
      ),
      getActiveAssumptions(input.tenantId, 5),
    ]);
  } catch (err) {
    console.warn("[chat] context fetch failed:", err);
  }

  // ── Per-turn context block (the persona itself is in the system prompt) ──
  const localTime = formatLocalTime(now, profile.timezone);
  const ctx: string[] = [
    `Today (UTC date — the meal database keys days by UTC date): ${today}. Now: ${now.toISOString()}${localTime ? ` = ${localTime}` : ""}.`,
  ];
  if (profileSummary) ctx.push(`Profile: ${profileSummary}.`);
  if (activeAssumptions.length > 0) {
    ctx.push(
      `Active assumptions about user: ` +
        activeAssumptions
          .map((a) => `[${a.id}] ${a.text} (${a.confidence})`)
          .join("; ") +
        `.`,
    );
  }
  if (!onboarded) {
    ctx.push(
      `[ONBOARDING NEEDED] User is not fully onboarded. Still missing: ${missingFields.join(", ")}. Ask 1-2 short, friendly questions per turn to gather these. Save answers via update_profile immediately.`,
    );
  }
  if (pendingFeedback.length > 0) {
    const m = pendingFeedback[0]!;
    const ageMin = Math.floor((now.getTime() - Date.parse(m.logged_at)) / 60000);
    ctx.push(
      `[PENDING FEEDBACK] Meal "${m.text}" (id ${m.id}) was logged ${ageMin}m ago and you haven't asked how it felt. If this turn has a natural opening, ask casually — only ONCE. When they answer, call record_feedback with meal_id "${m.id}". Skip if the moment doesn't fit.`,
    );
  }
  if (recentContext) ctx.push(recentContext);
  if (earlierPhotos.length > 0) {
    ctx.push(
      `Photos the user sent EARLIER (your photo memory, newest first — when they say "the pics I sent", this is what they mean):\n` +
        earlierPhotos
          .map((p) => {
            const ago = formatElapsed(
              Math.max(0, Math.floor((now.getTime() - Date.parse(p.at)) / 1000)),
            );
            const cap = p.caption ? ` (their caption: "${p.caption}")` : "";
            return `- ${ago} ago [${p.kind}]${cap}: ${p.description}`;
          })
          .join("\n"),
    );
  }
  if (input.voice) {
    ctx.push(
      `User sent this as a VOICE note (transcribed). Your reply will also be spoken aloud — keep it extra tight and natural to say.`,
    );
  }

  // ── What the user just sent ──────────────────────────────────────────────
  const text = input.text.trim();
  const msg: string[] = [];
  if (images.length > 0) {
    const dropped = input.photosDropped ?? 0;
    msg.push(
      `The user just sent ${images.length} photo${images.length === 1 ? "" : "s"}` +
        (dropped > 0
          ? ` (+${dropped} more that weren't analyzed — mention that briefly)`
          : "") +
        (text ? " together with a message:" : ", no caption:"),
    );
    visions.forEach((vis, i) => {
      msg.push(
        vis
          ? `Photo ${i + 1} [${vis.kind}]: ${vis.description}`
          : `Photo ${i + 1}: (couldn't analyze this one — say so briefly)`,
      );
    });
  }
  if (text) msg.push(`User says: "${text}"`);
  else if (images.length === 0) msg.push(`User says: ""`);

  const promptText = `[context]\n${ctx.join("\n")}\n[/context]\n\n${msg.join("\n")}`;

  try {
    const { data } = await session.prompt(promptText, {
      result: v.object({
        reply: v.string(),
      }),
    });
    return data;
  } finally {
    if (boxRef.current) {
      try {
        await boxRef.current.delete();
        console.log(`[chat] deleted ephemeral box`);
      } catch (err) {
        console.warn("[chat] box delete failed:", err);
      }
    }
  }
}
