import { describe, expect, it } from 'vitest';
import { BYOK_PROVIDERS } from './types.js';

describe('BYOK_PROVIDERS', () => {
  it('matches the LLM provider matrix from §2', () => {
    expect(BYOK_PROVIDERS).toEqual([
      'anthropic',
      'openai',
      'azure-openai',
      'google',
      'vertex',
      'bedrock',
      'openai-compatible',
    ]);
  });

  it('is a frozen const tuple usable as a discriminator type', () => {
    // typeof BYOK_PROVIDERS[number] is the union literal — sanity-check that
    // narrowing works at runtime via .includes.
    expect((BYOK_PROVIDERS as readonly string[]).includes('anthropic')).toBe(true);
    expect((BYOK_PROVIDERS as readonly string[]).includes('not-a-provider')).toBe(false);
  });
});
