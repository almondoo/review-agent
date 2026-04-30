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
