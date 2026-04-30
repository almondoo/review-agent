import type { ProviderType } from './types.js';

export type ProviderDefaults = {
  readonly default: string | null;
  readonly fallback: ReadonlyArray<string>;
};

export const PROVIDER_DEFAULTS: Readonly<Record<ProviderType, ProviderDefaults>> = {
  anthropic: {
    default: 'claude-sonnet-4-6',
    fallback: ['claude-sonnet-4-5', 'claude-haiku-4-5-20251001'],
  },
  openai: {
    default: 'gpt-4o',
    fallback: ['gpt-4o-mini'],
  },
  'azure-openai': {
    default: null,
    fallback: [],
  },
  google: {
    default: 'gemini-2.0-pro',
    fallback: ['gemini-2.0-flash'],
  },
  vertex: {
    default: 'gemini-2.0-pro',
    fallback: ['gemini-2.0-flash'],
  },
  bedrock: {
    default: 'anthropic.claude-sonnet-4-6-v1:0',
    fallback: ['anthropic.claude-sonnet-4-5-v1:0'],
  },
  'openai-compatible': {
    default: null,
    fallback: [],
  },
};
