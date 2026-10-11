export const MAIN_MODEL_ID = "zai-org/GLM-5.3-Flash";
export const MAIN_MODEL = `nebius/${MAIN_MODEL_ID}`;

/**
 * The same GLM-5.3-Flash served by another provider. Used while Nebius is
 * degraded (lib/modelHealth.ts): same behaviour, different infrastructure.
 */
export const FALLBACK_MODEL_ID = "z-ai/glm-5.3-flash";
export const FALLBACK_MODEL = `openrouter/${FALLBACK_MODEL_ID}`;
/** GLM-5.3-Flash's real window (used by Flue for compaction math). */
export const MAIN_MODEL_CONTEXT_WINDOW = 1_048_576;
/**
 * How much transcript we actually let a Telegram turn carry before Flue
 * compacts older turns into a summary. The model could take 1M tokens, but
 * every turn re-sends the whole transcript: at ~2k tokens/turn that's slow
 * and pricey long before the window is a problem. Facts live in Redis anyway.
 */
export const WORKING_CONTEXT_TOKENS = 60_000;

export const DEFAULT_VISION_FALLBACK_MODEL =
  "google/gemma-4-26b-a4b-it:free";
