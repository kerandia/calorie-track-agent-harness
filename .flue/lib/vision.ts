import {
  DEFAULT_VISION_FALLBACK_MODEL,
  MAIN_MODEL_ID,
} from "./models.js";

// Photo → structured text for the tool-enabled agent turn.
//
// Why a classification, not just "describe this": the agent's behaviour differs
// completely between a plate (log it), a fridge/pantry (don't log — remember the
// inventory and cook from it later), a label (quote numbers) and a non-food
// shot. The old 1-2 sentence description also threw away the inventory detail
// that "what can I cook from what I sent you?" needs.

export type PhotoKind =
  | "plated_meal"
  | "packaged_food"
  | "ingredients_storage"
  | "menu_or_recipe"
  | "not_food"
  | "unknown";

const KINDS: readonly PhotoKind[] = [
  "plated_meal",
  "packaged_food",
  "ingredients_storage",
  "menu_or_recipe",
  "not_food",
];

export type VisionResult = {
  kind: PhotoKind;
  description: string;
  model: string;
};

export type VisionOptions = {
  /** The user's caption / accompanying text, so the description fits the intent. */
  caption?: string;
  fallbackModel?: string;
};

const visionPrompt = (caption: string): string =>
  [
    "You are the eyes of a nutrition-tracking chat assistant. Look at the photo and reply in exactly this format:",
    "KIND: <one of plated_meal | packaged_food | ingredients_storage | menu_or_recipe | not_food>",
    "WHAT: <details as specified below>",
    "",
    "- plated_meal: food that is served or being eaten (plate, bowl, sandwich in hand, takeaway box). List each food item with an estimated portion, e.g. 'grilled salmon ~150g, white rice ~1 cup, broccoli ~80g'.",
    "- packaged_food: a product or its label. Give brand/product name, package weight, and every nutrition number you can read (kcal, protein, carbs, fat — per 100g and per serving if shown).",
    "- ingredients_storage: a fridge, freezer, pantry, shelf, cupboard or groceries — ingredients not yet cooked. Write an inventory: every identifiable item, with label text, brand, quantity or package size when visible. Be exhaustive; this is used later to suggest what to cook.",
    "- menu_or_recipe: a menu, recipe, or screenshot of food text. Transcribe the dishes/items and any numbers.",
    "- not_food: one short sentence about what it is.",
    "",
    "Be specific and confident. Plain text, no markdown, max 130 words.",
    caption
      ? `The user's message with this photo: "${caption}"`
      : "The user sent no caption.",
  ].join("\n");

type VisionEndpoint = {
  baseUrl: string;
  apiKey: string;
  model: string;
  attempts: number;
};

// GLM-5.3-Flash "thinks" before answering and those hidden tokens count
// against max_tokens. With the old 250-350 cap, ~200 tokens went to reasoning
// and the visible description was cut mid-sentence (finish_reason "length") —
// one reason the agent's picture of a fridge was so thin. Disabling thinking
// via chat_template_kwargs made the model leak its reasoning into the content
// instead (and took 4x longer), so keep thinking on and give it room: a full
// inventory answer runs ~250 tokens on top of ~200 reasoning.
const VISION_MAX_TOKENS = 900;

async function requestVision(
  image: { base64: string; mimeType: string },
  prompt: string,
  endpoint: VisionEndpoint,
): Promise<string> {
  const body = JSON.stringify({
    model: endpoint.model,
    max_tokens: VISION_MAX_TOKENS,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          {
            type: "image_url",
            image_url: {
              url: `data:${image.mimeType};base64,${image.base64}`,
            },
          },
        ],
      },
    ],
  });

  let lastStatus = 0;
  let lastBody = "";

  for (let attempt = 1; attempt <= endpoint.attempts; attempt++) {
    const res = await fetch(`${endpoint.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${endpoint.apiKey}`,
      },
      body,
    });

    if (res.ok) {
      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const description = data.choices?.[0]?.message?.content?.trim();
      if (description) return description;
      throw new Error("vision API returned an empty response");
    }

    lastStatus = res.status;
    lastBody = await res.text().catch(() => "(no body)");

    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt === endpoint.attempts) {
      throw new Error(`vision API failed ${lastStatus}: ${lastBody}`);
    }
    const delayMs = 1000 * 2 ** (attempt - 1);
    console.warn(
      `[vision] ${endpoint.model} returned ${lastStatus} on attempt ${attempt}, retrying in ${delayMs}ms`,
    );
    await new Promise((r) => setTimeout(r, delayMs));
  }

  throw new Error(`vision API failed ${lastStatus}: ${lastBody}`);
}

/** Split the model's "KIND: x / WHAT: ..." reply; tolerate sloppy formatting. */
function parseVision(raw: string): { kind: PhotoKind; description: string } {
  // Defensive: some serving stacks leak the reasoning block into the content.
  const think = raw.lastIndexOf("</think>");
  if (think !== -1) raw = raw.slice(think + "</think>".length);
  raw = raw.replace(/<think>[\s\S]*?<\/think>/g, "");
  const m = raw.match(/KIND:\s*([a-z_]+)/i);
  const candidate = m?.[1]?.toLowerCase() as PhotoKind | undefined;
  const kind: PhotoKind =
    candidate && KINDS.includes(candidate) ? candidate : "unknown";
  const description =
    raw
      .replace(/^\s*KIND:.*$/im, "")
      .replace(/^\s*WHAT:\s*/im, "")
      .replace(/\s+/g, " ")
      .trim() || raw.trim();
  return { kind, description };
}

export async function describeImage(
  image: { base64: string; mimeType: string },
  options: VisionOptions = {},
): Promise<VisionResult> {
  const prompt = visionPrompt(options.caption?.trim() ?? "");
  const fallbackModel = options.fallbackModel ?? DEFAULT_VISION_FALLBACK_MODEL;

  const nebiusKey = process.env.NEBIUS_API_KEY;
  if (nebiusKey) {
    try {
      const raw = await requestVision(image, prompt, {
        baseUrl: "https://api.tokenfactory.nebius.com/v1",
        apiKey: nebiusKey,
        model: MAIN_MODEL_ID,
        attempts: 2,
      });
      return { ...parseVision(raw), model: `nebius/${MAIN_MODEL_ID}` };
    } catch (err) {
      console.warn(
        `[vision] primary ${MAIN_MODEL_ID} failed; using Gemma fallback:`,
        err,
      );
    }
  } else {
    console.warn("[vision] NEBIUS_API_KEY not set; using Gemma fallback");
  }

  const openRouterKey = process.env.OPENROUTER_API_KEY;
  if (!openRouterKey) {
    throw new Error("OPENROUTER_API_KEY not set for vision fallback");
  }

  const raw = await requestVision(image, prompt, {
    baseUrl: "https://openrouter.ai/api/v1",
    apiKey: openRouterKey,
    model: fallbackModel,
    attempts: 3,
  });
  return { ...parseVision(raw), model: `openrouter/${fallbackModel}` };
}
