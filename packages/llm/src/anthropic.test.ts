import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type AnthropicDriverDeps,
  classifyAnthropicError,
  createAnthropicProvider,
} from './anthropic.js';
import type { ProviderConfig, ReviewInput } from './types.js';

const baseConfig: ProviderConfig = {
  type: 'anthropic',
  model: 'claude-sonnet-4-6',
  apiKey: 'test-key',
};

const reviewInput: ReviewInput = {
  systemPrompt: 'You are an expert reviewer.',
  diffText: 'diff --git a/x b/x',
  prMetadata: { title: 'Title', body: 'Body', author: 'alice' },
  fileReader: async () => 'unused',
  language: 'en-US',
};

const reviewObject = {
  summary: 'No critical issues.',
  comments: [
    {
      path: 'src/x.ts',
      line: 1,
      side: 'RIGHT' as const,
      body: 'Looks good.',
      severity: 'info' as const,
    },
  ],
};

function makeDeps(overrides: Partial<AnthropicDriverDeps> = {}): AnthropicDriverDeps {
  return {
    createClient: vi.fn(() => ((model: string) => ({ id: model })) as never),
    generate: vi.fn(async () => ({
      experimental_output: reviewObject,
      totalUsage: { inputTokens: 1000, outputTokens: 200 },
      steps: [],
    })) as never,
    ...overrides,
  };
}

describe('createAnthropicProvider', () => {
  beforeEach(() => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('throws if config.type is not anthropic', () => {
    expect(() => createAnthropicProvider({ ...baseConfig, type: 'openai' }, makeDeps())).toThrow(
      /anthropic/i,
    );
  });

  it('throws if model is empty', () => {
    expect(() => createAnthropicProvider({ ...baseConfig, model: '' }, makeDeps())).toThrow(
      /model/,
    );
  });

  it('throws if no API key is configured', () => {
    expect(() => createAnthropicProvider({ ...baseConfig, apiKey: undefined }, makeDeps())).toThrow(
      /ANTHROPIC_API_KEY/,
    );
  });

  it('falls back to ANTHROPIC_API_KEY env', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'env-key');
    const deps = makeDeps();
    expect(() => createAnthropicProvider({ ...baseConfig, apiKey: undefined }, deps)).not.toThrow();
    expect(deps.createClient).toHaveBeenCalledWith({ apiKey: 'env-key' });
  });

  it('exposes provider name and model', () => {
    const provider = createAnthropicProvider(baseConfig, makeDeps());
    expect(provider.name).toBe('anthropic');
    expect(provider.model).toBe('claude-sonnet-4-6');
  });

  it('pricePerMillionTokens returns Sonnet 4.6 prices', () => {
    const provider = createAnthropicProvider(baseConfig, makeDeps());
    expect(provider.pricePerMillionTokens()).toEqual({ input: 3, output: 15 });
  });

  it('pricePerMillionTokens throws for unknown model', () => {
    const provider = createAnthropicProvider(
      { ...baseConfig, model: 'claude-unknown-model' },
      makeDeps(),
    );
    expect(() => provider.pricePerMillionTokens()).toThrow(/No price entry/);
  });

  it('generateReview returns parsed object + usage + computed cost', async () => {
    const deps = makeDeps();
    const provider = createAnthropicProvider(baseConfig, deps);
    const result = await provider.generateReview(reviewInput);
    expect(result.summary).toBe(reviewObject.summary);
    expect(result.comments).toEqual(reviewObject.comments);
    expect(result.tokensUsed).toEqual({ input: 1000, output: 200 });
    expect(result.costUsd).toBeCloseTo((1000 / 1_000_000) * 3 + (200 / 1_000_000) * 15);
  });

  it('generateReview composes <untrusted> wrapper around PR metadata', async () => {
    const deps = makeDeps();
    const provider = createAnthropicProvider(baseConfig, deps);
    await provider.generateReview(reviewInput);
    const callArgs = (deps.generate as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    const userMessage = callArgs.messages.find((m: { role: string }) => m.role === 'user');
    const userText = userMessage.content[0].text;
    expect(userText).toContain('<untrusted>');
    expect(userText).toContain('<title>Title</title>');
    expect(userText).toContain('<author>alice</author>');
    expect(userText).toContain('</untrusted>');
    expect(userText).toContain('<diff>');
  });

  it('generateReview attaches anthropic cacheControl=ephemeral by default', async () => {
    const deps = makeDeps();
    const provider = createAnthropicProvider(baseConfig, deps);
    await provider.generateReview(reviewInput);
    const callArgs = (deps.generate as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    const systemMessage = callArgs.messages.find((m: { role: string }) => m.role === 'system');
    expect(systemMessage.content[0].providerOptions).toEqual({
      anthropic: { cacheControl: { type: 'ephemeral' } },
    });
  });

  it('generateReview omits cacheControl when anthropicCacheControl=false', async () => {
    const deps = makeDeps();
    const provider = createAnthropicProvider({ ...baseConfig, anthropicCacheControl: false }, deps);
    await provider.generateReview(reviewInput);
    const callArgs = (deps.generate as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    const systemMessage = callArgs.messages.find((m: { role: string }) => m.role === 'system');
    expect(systemMessage.content[0].providerOptions).toBeUndefined();
  });

  it('estimateCost returns positive token count + USD using fallback tokenizer', async () => {
    const provider = createAnthropicProvider(baseConfig, makeDeps());
    const result = await provider.estimateCost(reviewInput);
    expect(result.inputTokens).toBeGreaterThan(0);
    expect(result.estimatedUsd).toBeGreaterThan(0);
  });

  it('estimateCost honors injected tokenizer', async () => {
    const tokenize = vi.fn(() => 5_000);
    const provider = createAnthropicProvider(baseConfig, { ...makeDeps(), tokenize });
    const result = await provider.estimateCost(reviewInput);
    expect(tokenize).toHaveBeenCalled();
    expect(result.inputTokens).toBe(5_000);
    expect(result.estimatedUsd).toBeCloseTo(0.015);
  });
});

describe('classifyAnthropicError', () => {
  it('classifies HTTP 429 with retry-after header as rate_limit', () => {
    const result = classifyAnthropicError({
      status: 429,
      headers: { 'retry-after': '12' },
    });
    expect(result).toEqual({ kind: 'rate_limit', retryAfterMs: 12_000 });
  });

  it('classifies HTTP 429 without retry-after as rate_limit (no delay)', () => {
    expect(classifyAnthropicError({ status: 429 })).toEqual({ kind: 'rate_limit' });
  });

  it('classifies HTTP 529 as overloaded', () => {
    expect(classifyAnthropicError({ status: 529 })).toEqual({ kind: 'overloaded' });
  });

  it('classifies HTTP 401 as auth (no retry)', () => {
    expect(classifyAnthropicError({ status: 401 })).toEqual({ kind: 'auth' });
  });

  it('classifies HTTP 403 as auth', () => {
    expect(classifyAnthropicError({ status: 403 })).toEqual({ kind: 'auth' });
  });

  it('classifies context-length messages as context_length', () => {
    // Pin every alternation in looksLikeContextLength's regex
    // (/context.{0,5}length|too long|maximum context|prompt is too long/i).
    // Tightening the pattern in production must update these tests deliberately.
    for (const message of [
      'prompt is too long for context window',
      'maximum context length is 200000 tokens',
      'context_length_exceeded',
      'Context Length exceeded',
      'input is too long',
    ]) {
      expect(classifyAnthropicError({ message })).toEqual({ kind: 'context_length' });
    }
  });

  it('classifies network errors as transient', () => {
    expect(classifyAnthropicError({ code: 'ECONNRESET' })).toEqual({ kind: 'transient' });
    expect(classifyAnthropicError({ code: 'ETIMEDOUT' })).toEqual({ kind: 'transient' });
  });

  it('classifies unknown errors as fatal', () => {
    expect(classifyAnthropicError(new Error('???'))).toEqual({ kind: 'fatal' });
    expect(classifyAnthropicError(null)).toEqual({ kind: 'fatal' });
    expect(classifyAnthropicError({})).toEqual({ kind: 'fatal' });
    expect(classifyAnthropicError('boom')).toEqual({ kind: 'fatal' });
  });
});

describe('error classification integrates with provider.classifyError', () => {
  it('exposes classifyError that matches classifyAnthropicError', () => {
    const provider = createAnthropicProvider(baseConfig, makeDeps());
    expect(provider.classifyError({ status: 429 })).toEqual({ kind: 'rate_limit' });
  });
});

// Stage C: branch coverage hardening for `readHeader` + `generateReview` usage
// fallback. These pin paths only reachable on lower-cased header names and on
// SDK responses that omit the standard `totalUsage` / `usage` keys.

describe('classifyAnthropicError — header coalesce branches', () => {
  it('reads `Retry-After` via the lower-cased header bag entry', () => {
    // The `(bag)[name] ?? (bag)[name.toLowerCase()]` coalesce: the first
    // lookup misses (header key only present in the lowercased form),
    // forcing the helper to fall through to the second arm.
    const result = classifyAnthropicError({
      status: 429,
      headers: { 'Retry-After': undefined, 'retry-after': '7' },
    });
    expect(result).toEqual({ kind: 'rate_limit', retryAfterMs: 7_000 });
  });

  it('reads a numeric `retry-after` header value (number branch)', () => {
    // The `typeof value === 'number' ? String(value) : ...` branch — a
    // few SDKs surface retry-after as a number rather than a stringified
    // header. The helper coerces to string before the parseFloat in
    // classifyHttpStyleError; here we pin the same fallback inside
    // classifyAnthropicError's reader.
    const result = classifyAnthropicError({
      status: 429,
      headers: { 'retry-after': 3 },
    });
    expect(result).toEqual({ kind: 'rate_limit', retryAfterMs: 3_000 });
  });

  it('falls through `responseHeaders` when `headers` is absent', () => {
    // `for (const bag of [candidate.headers, candidate.responseHeaders])`
    // — second iteration. Many fetch-style errors put the header bag on
    // `responseHeaders` instead of `headers`.
    const result = classifyAnthropicError({
      status: 429,
      responseHeaders: { 'retry-after': '5' },
    });
    expect(result).toEqual({ kind: 'rate_limit', retryAfterMs: 5_000 });
  });
});

describe('createAnthropicProvider — generateReview defensive defaults', () => {
  it('treats a result with no usage / totalUsage as zero tokens (cost = 0)', async () => {
    // The `totalUsage ?? usage ?? {}` chain reaches the tail arm when
    // neither key is present. inputTokens / outputTokens then fall
    // through to 0 and the cost becomes 0.
    const deps = makeDeps({
      generate: vi.fn(async () => ({
        experimental_output: reviewObject,
        // no totalUsage, no usage
        steps: [],
      })) as never,
    });
    const provider = createAnthropicProvider(baseConfig, deps);
    const result = await provider.generateReview(reviewInput);
    expect(result.tokensUsed).toEqual({ input: 0, output: 0 });
    expect(result.costUsd).toBe(0);
  });

  it('reads `usage` when `totalUsage` is absent (fallback chain middle arm)', async () => {
    // First-arm miss, middle-arm hit on `?? usage ?? {}`. Older AI SDK
    // versions emitted `usage` instead of `totalUsage`; pin compat.
    const deps = makeDeps({
      generate: vi.fn(async () => ({
        experimental_output: reviewObject,
        usage: { inputTokens: 250, outputTokens: 90 },
        steps: [],
      })) as never,
    });
    const provider = createAnthropicProvider(baseConfig, deps);
    const result = await provider.generateReview(reviewInput);
    expect(result.tokensUsed).toEqual({ input: 250, output: 90 });
  });
});
