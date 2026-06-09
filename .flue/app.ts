import { flue, registerProvider } from "@flue/runtime/app";

/**
 * Runtime provider/model config (build-time config lives in flue.config.ts).
 *
 * We register the OpenRouter prefix explicitly because:
 *  1. Some models we use (e.g. nvidia/nemotron-3-ultra-550b-a55b:free) are
 *     newer than pi-ai's bundled catalog, so Flue's resolver rejects them
 *     with "Unknown model" unless we declare them here.
 *  2. It lets us cap maxTokens. Flue otherwise reserves up to 32k output
 *     tokens per call, which OpenRouter pre-authorizes against the balance —
 *     wasteful, and a source of 402s when credits run low. Our replies are
 *     tiny; 8k is plenty for reply + tool calls.
 *
 * Caveat: a registered prefix WINS over pi-ai's catalog for ALL models under
 * it, so cost telemetry reads 0 and the reasoning flag is off for catalog
 * models (e.g. deepseek) routed this way. Fine while on a free model. When
 * switching back to paid deepseek and you want cost tracking, either remove
 * this registration (deepseek resolves natively) or add it to `models` with
 * accurate metadata.
 */
registerProvider("openrouter", {
  api: "openai-completions",
  baseUrl: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY,
  contextWindow: 131072,
  maxTokens: 8000,
  models: {
    "nvidia/nemotron-3-ultra-550b-a55b:free": {
      contextWindow: 131072,
      maxTokens: 8000,
    },
    "deepseek/deepseek-v4-pro": {
      contextWindow: 1048576,
      maxTokens: 8000,
    },
  },
});

/**
 * Nebius Token Factory — OpenAI-compatible inference endpoint.
 * Base URL and auth verified from docs.tokenfactory.nebius.com.
 * Reference a model as `nebius/<model-id>` in the agent's init({ model }).
 * Add per-model contextWindow once known; defaults below are conservative.
 */
registerProvider("nebius", {
  api: "openai-completions",
  baseUrl: "https://api.tokenfactory.nebius.com/v1",
  apiKey: process.env.NEBIUS_API_KEY,
  contextWindow: 262144,
  maxTokens: 8000,
  models: {
    "MiniMaxAI/MiniMax-M2.5": {
      contextWindow: 196608,
      maxTokens: 8000,
    },
    "Qwen/Qwen3-30B-A3B-Instruct-2507": {
      contextWindow: 262144,
      maxTokens: 8000,
    },
    "deepseek-ai/DeepSeek-V4-Pro": {
      contextWindow: 163840,
      maxTokens: 8000,
    },
  },
});

export default flue();
