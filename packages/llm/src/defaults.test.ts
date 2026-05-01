import { describe, expect, it } from 'vitest';
import { PROVIDER_DEFAULTS } from './defaults.js';
import { PROVIDER_TYPES } from './types.js';

describe('PROVIDER_DEFAULTS', () => {
  it('has an entry for every ProviderType', () => {
    for (const type of PROVIDER_TYPES) {
      expect(PROVIDER_DEFAULTS).toHaveProperty(type);
    }
  });

  it('anthropic defaults to claude-sonnet-4-6', () => {
    expect(PROVIDER_DEFAULTS.anthropic.default).toBe('claude-sonnet-4-6');
    expect(PROVIDER_DEFAULTS.anthropic.fallback.length).toBeGreaterThan(0);
  });

  it('azure-openai and openai-compatible require user-specified model (default null)', () => {
    expect(PROVIDER_DEFAULTS['azure-openai'].default).toBeNull();
    expect(PROVIDER_DEFAULTS['openai-compatible'].default).toBeNull();
  });

  it('all non-null defaults specify a fallback chain', () => {
    for (const type of PROVIDER_TYPES) {
      const entry = PROVIDER_DEFAULTS[type];
      if (entry.default !== null) {
        expect(entry.fallback.length).toBeGreaterThan(0);
      }
    }
  });

  it('every provider with a non-null default also pins a cheapest model', () => {
    for (const type of PROVIDER_TYPES) {
      const entry = PROVIDER_DEFAULTS[type];
      // Either both null (operator-supplied) or both populated.
      if (entry.default === null) {
        expect(entry.cheapest).toBeNull();
      } else {
        expect(entry.cheapest).toBeTruthy();
      }
    }
  });

  it('anthropic / openai / bedrock cheapest match the spec §7.3 list', () => {
    expect(PROVIDER_DEFAULTS.anthropic.cheapest).toBe('claude-haiku-4-5-20251001');
    expect(PROVIDER_DEFAULTS.openai.cheapest).toBe('gpt-4o-mini');
    expect(PROVIDER_DEFAULTS.bedrock.cheapest).toBe('anthropic.claude-haiku-4-5-v1:0');
  });
});
