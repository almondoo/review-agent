import { BEDROCK_PRICING } from './pricing.js';
import {
  classifyHttpStyleError,
  createGenericProvider,
  type ProviderDriverDeps,
  type ProviderShape,
} from './provider-base.js';
import type { LlmProvider, ProviderConfig } from './types.js';

// AWS Bedrock — Anthropic models on AWS. The actual SDK wiring
// (`@ai-sdk/amazon-bedrock` `createAmazonBedrock`) is injected via
// `deps.modelForRequest` so test-only callers don't need the SDK.
//
// Production wiring example:
//
//   import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
//   const bedrock = createAmazonBedrock({ region: config.region });
//   createBedrockProvider(config, { modelForRequest: (m) => bedrock(m) });
//
// We also fall back to `import('@ai-sdk/amazon-bedrock')` lazily in
// production, so packages that *don't* use Bedrock never pay the
// dependency cost.

export type BedrockDriverDeps = ProviderDriverDeps & {
  /** Builds the AI-SDK language-model object. Defaults to a lazy import. */
  readonly modelForRequest?: (model: string) => unknown;
};

const VALID_TYPE = 'bedrock';

export async function createBedrockProvider(
  config: ProviderConfig,
  deps: BedrockDriverDeps = {},
): Promise<LlmProvider> {
  if (config.type !== VALID_TYPE) {
    throw new Error(`createBedrockProvider received provider.type='${config.type}'`);
  }
  if (!config.model) throw new Error('createBedrockProvider requires config.model');
  if (!config.region) {
    throw new Error('createBedrockProvider requires config.region (e.g. us-east-1)');
  }

  const modelForRequest = deps.modelForRequest ?? (await defaultBedrockModelFactory(config.region));
  const shape: ProviderShape<unknown> = {
    name: 'bedrock',
    pricing: BEDROCK_PRICING,
    classifyError: classifyHttpStyleError,
    modelForRequest,
  };
  return createGenericProvider(shape, config.model, deps);
}

async function defaultBedrockModelFactory(region: string): Promise<(model: string) => unknown> {
  // Lazy import so consumers without Bedrock don't need the SDK.
  const mod = (await import('@ai-sdk/amazon-bedrock')) as {
    createAmazonBedrock: (opts: { region: string }) => (model: string) => unknown;
  };
  const bedrock = mod.createAmazonBedrock({ region });
  return (model) => bedrock(model);
}
