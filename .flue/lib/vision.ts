const VISION_PROMPT =
  "Describe this image in 1-2 sentences. " +
  "If it shows food on a plate, identify each visible item. " +
  "Be confident and concise; downstream will estimate calories.";

export async function describeImage(
  image: { base64: string; mimeType: string },
  model: string,
): Promise<string> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY not set");

  const body = JSON.stringify({
    model,
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

  const MAX_ATTEMPTS = 3;
  let lastStatus = 0;
  let lastBody = "";

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const res = await fetch(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body,
      },
    );

    if (res.ok) {
      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      return data.choices?.[0]?.message?.content?.trim() ?? "";
    }

    lastStatus = res.status;
    lastBody = await res.text().catch(() => "(no body)");

    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt === MAX_ATTEMPTS) {
      throw new Error(`vision API failed ${lastStatus}: ${lastBody}`);
    }
    const delayMs = 1000 * 2 ** (attempt - 1);
    console.warn(
      `[vision] ${lastStatus} on attempt ${attempt}, retrying in ${delayMs}ms`,
    );
    await new Promise((r) => setTimeout(r, delayMs));
  }

  throw new Error(`vision API failed ${lastStatus}: ${lastBody}`);
}
