import { OPENAI_COMPATIBLE_PRICING } from './pricing.js';
import {
  classifyHttpStyleError,
  createGenericProvider,
  type ProviderDriverDeps,
  type ProviderShape,
} from './provider-base.js';
import type { LlmProvider, ProviderConfig } from './types.js';

// OpenAI-compatible endpoint (Ollama, vLLM, OpenRouter, LM Studio,
// LiteLLM proxy, ...). Operator supplies `base_url`; auth is
// optional and many local endpoints accept any non-empty string.
//
// Caveat: structured-output support varies. The AI SDK falls back
// to JSON-mode prompting when tool-calling is unavailable, but some
// endpoints (small Ollama models, especially) emit malformed JSON
// for the ReviewOutputSchema. The recommended remedy is documented
// in `docs/providers/openai-compatible.md`.

export type OpenAICompatibleDriverDeps = ProviderDriverDeps & {
  readonly modelForRequest?: (model: string) => unknown;
};

export async function createOpenAICompatibleProvider(
  config: ProviderConfig,
  deps: OpenAICompatibleDriverDeps = {},
): Promise<LlmProvider> {
  if (config.type !== 'openai-compatible') {
    throw new Error(`createOpenAICompatibleProvider received provider.type='${config.type}'`);
  }
  if (!config.model) throw new Error('createOpenAICompatibleProvider requires config.model');
  if (!config.baseUrl) {
    throw new Error(
      'createOpenAICompatibleProvider requires config.baseUrl (the endpoint origin, e.g. http://localhost:11434/v1)',
    );
  }
  const apiKey = config.apiKey ?? process.env.OPENAI_API_KEY ?? '';

  const modelForRequest =
    deps.modelForRequest ??
    (await defaultOpenAICompatibleModelFactory({
      baseUrl: config.baseUrl,
      apiKey,
    }));
  const shape: ProviderShape<unknown> = {
    name: 'openai-compatible',
    pricing: OPENAI_COMPATIBLE_PRICING,
    classifyError: classifyHttpStyleError,
    modelForRequest,
  };
  return createGenericProvider(shape, config.model, deps);
}

async function defaultOpenAICompatibleModelFactory(opts: {
  baseUrl: string;
  apiKey: string;
}): Promise<(model: string) => unknown> {
  const mod = (await import('@ai-sdk/openai-compatible')) as {
    createOpenAICompatible: (opts: {
      name: string;
      apiKey?: string;
      baseURL: string;
    }) => (model: string) => unknown;
  };
  const client = mod.createOpenAICompatible({
    name: 'openai-compatible',
    apiKey: opts.apiKey,
    baseURL: opts.baseUrl,
  });
  return (model) => client(model);
}
