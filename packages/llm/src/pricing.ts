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

export function priceForModel(
  table: Readonly<Record<string, ModelPrice>>,
  model: string,
): ModelPrice {
  const price = table[model];
  if (!price) {
    throw new Error(
      `No price entry for model '${model}'. Update the provider's pricing table to include it.`,
    );
  }
  return price;
}
