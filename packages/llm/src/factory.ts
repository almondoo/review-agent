import { createAnthropicProvider } from './anthropic.js';
import { createAzureOpenAIProvider } from './azure-openai.js';
import { createBedrockProvider } from './bedrock.js';
import { createGoogleProvider } from './google.js';
import { createOpenAIProvider } from './openai.js';
import { createOpenAICompatibleProvider } from './openai-compatible.js';
import type { LlmProvider, ProviderConfig } from './types.js';
import { createVertexProvider } from './vertex.js';

// One-stop dispatcher (`createProvider(config)`) for every supported
// `provider.type`. Each driver decides whether it needs an async
// SDK import; we mirror that by returning a Promise unconditionally
// and let synchronous callers `await` once.
//
// The Anthropic + OpenAI drivers are kept synchronous (their SDKs
// are direct dependencies of this package); we wrap them in
// Promise.resolve so the dispatcher's signature is uniform.
export async function createProvider(config: ProviderConfig): Promise<LlmProvider> {
  switch (config.type) {
    case 'anthropic':
      return createAnthropicProvider(config);
    case 'openai':
      return createOpenAIProvider(config);
    case 'azure-openai':
      return createAzureOpenAIProvider(config);
    case 'google':
      return createGoogleProvider(config);
    case 'vertex':
      return createVertexProvider(config);
    case 'bedrock':
      return createBedrockProvider(config);
    case 'openai-compatible':
      return createOpenAICompatibleProvider(config);
    default: {
      // Exhaustiveness check — TypeScript narrows `config.type` to
      // `never` inside this branch when every union member is
      // handled. Runtime fallback for forward-compat.
      const exhaustive: never = config as never;
      throw new Error(`Unsupported provider.type: ${(exhaustive as { type: string }).type}`);
    }
  }
}
