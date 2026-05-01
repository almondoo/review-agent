import { GOOGLE_PRICING } from './pricing.js';
import {
  classifyHttpStyleError,
  createGenericProvider,
  type ProviderDriverDeps,
  type ProviderShape,
} from './provider-base.js';
import type { LlmProvider, ProviderConfig } from './types.js';

// Google AI Studio (Gemini direct, AI Studio API key). For Vertex
// AI on a GCP project, use `vertex.ts` instead.

export type GoogleDriverDeps = ProviderDriverDeps & {
  readonly modelForRequest?: (model: string) => unknown;
};

export async function createGoogleProvider(
  config: ProviderConfig,
  deps: GoogleDriverDeps = {},
): Promise<LlmProvider> {
  if (config.type !== 'google') {
    throw new Error(`createGoogleProvider received provider.type='${config.type}'`);
  }
  if (!config.model) throw new Error('createGoogleProvider requires config.model');
  const apiKey = config.apiKey ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  if (!apiKey) {
    throw new Error(
      'Google AI Studio API key not configured. Set GOOGLE_GENERATIVE_AI_API_KEY env or provide config.apiKey.',
    );
  }

  const modelForRequest = deps.modelForRequest ?? (await defaultGoogleModelFactory(apiKey));
  const shape: ProviderShape<unknown> = {
    name: 'google',
    pricing: GOOGLE_PRICING,
    classifyError: classifyHttpStyleError,
    modelForRequest,
  };
  return createGenericProvider(shape, config.model, deps);
}

async function defaultGoogleModelFactory(apiKey: string): Promise<(model: string) => unknown> {
  const mod = (await import('@ai-sdk/google')) as {
    createGoogleGenerativeAI: (opts: { apiKey: string }) => (model: string) => unknown;
  };
  const google = mod.createGoogleGenerativeAI({ apiKey });
  return (model) => google(model);
}
