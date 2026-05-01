export type ModelPrice = {
  readonly inputPerMTok: number;
  readonly outputPerMTok: number;
  readonly cacheReadPerMTok: number;
  readonly cacheWritePerMTok: number;
};

export const ANTHROPIC_PRICING: Readonly<Record<string, ModelPrice>> = {
  'claude-sonnet-4-6': {
    inputPerMTok: 3.0,
    outputPerMTok: 15.0,
    cacheReadPerMTok: 0.3,
    cacheWritePerMTok: 3.75,
  },
  'claude-sonnet-4-5': {
    inputPerMTok: 3.0,
    outputPerMTok: 15.0,
    cacheReadPerMTok: 0.3,
    cacheWritePerMTok: 3.75,
  },
  'claude-haiku-4-5-20251001': {
    inputPerMTok: 0.8,
    outputPerMTok: 4.0,
    cacheReadPerMTok: 0.08,
    cacheWritePerMTok: 1.0,
  },
};

// OpenAI prices update more frequently than Anthropic's. Source:
// https://openai.com/api/pricing/. Cache columns are 0 — OpenAI does not
// expose a prompt-caching feature compatible with our abstraction.
export const OPENAI_PRICING: Readonly<Record<string, ModelPrice>> = {
  'gpt-4o': {
    inputPerMTok: 2.5,
    outputPerMTok: 10.0,
    cacheReadPerMTok: 0,
    cacheWritePerMTok: 0,
  },
  'gpt-4o-mini': {
    inputPerMTok: 0.15,
    outputPerMTok: 0.6,
    cacheReadPerMTok: 0,
    cacheWritePerMTok: 0,
  },
  'gpt-4.1': {
    inputPerMTok: 2.0,
    outputPerMTok: 8.0,
    cacheReadPerMTok: 0,
    cacheWritePerMTok: 0,
  },
  'gpt-4.1-mini': {
    inputPerMTok: 0.4,
    outputPerMTok: 1.6,
    cacheReadPerMTok: 0,
    cacheWritePerMTok: 0,
  },
};

// Azure OpenAI: deployment-name-keyed. Prices follow OpenAI's table
// (Microsoft prices the same per-million tokens for Azure deployments
// of the same model). Operators add their deployment name → model
// mapping at config-load time, then look up by the *underlying*
// model id; we expose a flat OpenAI-equivalent here as the default.
export const AZURE_OPENAI_PRICING = OPENAI_PRICING;

// Google AI Studio (Gemini direct). Prices in USD per million tokens
// at 2026-04 GA pricing — verify against console.cloud.google.com.
export const GOOGLE_PRICING: Readonly<Record<string, ModelPrice>> = {
  'gemini-2.0-pro': {
    inputPerMTok: 1.25,
    outputPerMTok: 5.0,
    cacheReadPerMTok: 0,
    cacheWritePerMTok: 0,
  },
  'gemini-2.0-flash': {
    inputPerMTok: 0.075,
    outputPerMTok: 0.3,
    cacheReadPerMTok: 0,
    cacheWritePerMTok: 0,
  },
};

// Vertex AI: same prices as the corresponding Anthropic / Google
// API (Google publishes Vertex pricing as parity with the public
// API at GA). Track separately so a divergence is noticeable.
export const VERTEX_PRICING: Readonly<Record<string, ModelPrice>> = {
  ...GOOGLE_PRICING,
  'claude-sonnet-4-6@anthropic': {
    inputPerMTok: 3.0,
    outputPerMTok: 15.0,
    cacheReadPerMTok: 0.3,
    cacheWritePerMTok: 3.75,
  },
};

// AWS Bedrock — Anthropic models surface with the `anthropic.` prefix
// and a `:0` revision suffix.
export const BEDROCK_PRICING: Readonly<Record<string, ModelPrice>> = {
  'anthropic.claude-sonnet-4-6-v1:0': {
    inputPerMTok: 3.0,
    outputPerMTok: 15.0,
    cacheReadPerMTok: 0.3,
    cacheWritePerMTok: 3.75,
  },
  'anthropic.claude-sonnet-4-5-v1:0': {
    inputPerMTok: 3.0,
    outputPerMTok: 15.0,
    cacheReadPerMTok: 0.3,
    cacheWritePerMTok: 3.75,
  },
  'anthropic.claude-haiku-4-5-v1:0': {
    inputPerMTok: 0.8,
    outputPerMTok: 4.0,
    cacheReadPerMTok: 0.08,
    cacheWritePerMTok: 1.0,
  },
};

// OpenAI-compatible: BYO endpoints (Ollama, vLLM, OpenRouter, LM
// Studio, ...). Pricing is ill-defined — many endpoints are local
// (free) or aggregator-priced. We default to zero so cost-cap
// budgets pass through; operators can override per model in their
// own pricing table at config-load time.
export const OPENAI_COMPATIBLE_PRICING: Readonly<Record<string, ModelPrice>> = {};

export function priceForModel(
  table: Readonly<Record<string, ModelPrice>>,
  model: string,
): ModelPrice {
  const price = table[model];
  if (!price) {
    // OpenAI-compatible endpoints often run unpriced models. Treat
    // missing entries as zero-cost and let the operator override
    // when they care about cost caps for those models.
    if (table === OPENAI_COMPATIBLE_PRICING) {
      return { inputPerMTok: 0, outputPerMTok: 0, cacheReadPerMTok: 0, cacheWritePerMTok: 0 };
    }
    throw new Error(
      `No price entry for model '${model}'. Update the provider's pricing table to include it.`,
    );
  }
  return price;
}
