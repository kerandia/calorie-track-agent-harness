import {
  DEFAULT_VISION_FALLBACK_MODEL,
  MAIN_MODEL_ID,
} from "./models.js";

const VISION_PROMPT =
  "Describe this image in 1-2 sentences. " +
  "If it shows food on a plate, identify each visible item. " +
  "Be confident and concise; downstream will estimate calories.";

type VisionResult = {
  description: string;
  model: string;
};

type VisionEndpoint = {
  baseUrl: string;
  apiKey: string;
  model: string;
  attempts: number;
};

async function requestVision(
  image: { base64: string; mimeType: string },
  endpoint: VisionEndpoint,
): Promise<string> {
  const body = JSON.stringify({
    model: endpoint.model,
    max_tokens: 250,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: VISION_PROMPT },
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

export async function describeImage(
  image: { base64: string; mimeType: string },
  fallbackModel = DEFAULT_VISION_FALLBACK_MODEL,
): Promise<VisionResult> {
  const nebiusKey = process.env.NEBIUS_API_KEY;
  if (nebiusKey) {
    try {
      return {
        description: await requestVision(image, {
          baseUrl: "https://api.tokenfactory.nebius.com/v1",
          apiKey: nebiusKey,
          model: MAIN_MODEL_ID,
          attempts: 2,
        }),
        model: `nebius/${MAIN_MODEL_ID}`,
      };
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

  return {
    description: await requestVision(image, {
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: openRouterKey,
      model: fallbackModel,
      attempts: 3,
    }),
    model: `openrouter/${fallbackModel}`,
  };
}
