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
});
