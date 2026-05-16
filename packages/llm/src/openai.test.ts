import { describe, expect, it, vi } from 'vitest';
import { classifyOpenAIError, createOpenAIProvider } from './openai.js';
import type { ReviewInput } from './types.js';

const baseInput: ReviewInput = {
  systemPrompt: 'system',
  diffText: '+++ a\n-old\n+new\n',
  prMetadata: { title: 't', body: 'b', author: 'a' },
  fileReader: async () => '',
  language: 'en-US',
};

describe('classifyOpenAIError', () => {
  it('classifies 401 as auth (no retry)', () => {
    expect(classifyOpenAIError({ status: 401 })).toEqual({ kind: 'auth' });
    expect(classifyOpenAIError({ status: 403 })).toEqual({ kind: 'auth' });
  });

  it('classifies 429 with retry-after-ms (header takes priority over seconds)', () => {
    const err = { status: 429, headers: { 'retry-after-ms': '4500', 'retry-after': '60' } };
    expect(classifyOpenAIError(err)).toEqual({ kind: 'rate_limit', retryAfterMs: 4500 });
  });

  it('classifies 429 with retry-after seconds when ms missing', () => {
    expect(classifyOpenAIError({ status: 429, headers: { 'retry-after': '7' } })).toEqual({
      kind: 'rate_limit',
      retryAfterMs: 7000,
    });
  });

  it('classifies 429 with no retry header', () => {
    expect(classifyOpenAIError({ status: 429 })).toEqual({ kind: 'rate_limit' });
  });

  it('classifies 500 / 503 as overloaded', () => {
    expect(classifyOpenAIError({ status: 500 })).toEqual({ kind: 'overloaded' });
    expect(classifyOpenAIError({ status: 503 })).toEqual({ kind: 'overloaded' });
  });

  it('classifies context_length_exceeded code as context_length', () => {
    expect(classifyOpenAIError({ code: 'context_length_exceeded' })).toEqual({
      kind: 'context_length',
    });
  });

  it('classifies "context length" message as context_length even with 400 status', () => {
    expect(
      classifyOpenAIError({ status: 400, message: "This model's maximum context length is..." }),
    ).toEqual({ kind: 'context_length' });
  });

  it('classifies network errors as transient', () => {
    expect(classifyOpenAIError({ code: 'ECONNRESET' })).toEqual({ kind: 'transient' });
    expect(classifyOpenAIError({ code: 'ETIMEDOUT' })).toEqual({ kind: 'transient' });
  });

  it('falls back to fatal on unknown', () => {
    expect(classifyOpenAIError(new Error('oops'))).toEqual({ kind: 'fatal' });
    expect(classifyOpenAIError(null)).toEqual({ kind: 'fatal' });
  });
});

describe('createOpenAIProvider', () => {
  it('rejects mismatched provider type', () => {
    expect(() => createOpenAIProvider({ type: 'anthropic', model: 'gpt-4o', apiKey: 'k' })).toThrow(
      /createOpenAIProvider/,
    );
  });

  it('requires a model', () => {
    expect(() => createOpenAIProvider({ type: 'openai', model: '', apiKey: 'k' })).toThrow(
      /requires config.model/,
    );
  });

  it('requires an API key (env or config)', () => {
    const env = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      expect(() => createOpenAIProvider({ type: 'openai', model: 'gpt-4o' })).toThrow(
        /API key not configured/,
      );
    } finally {
      if (env) process.env.OPENAI_API_KEY = env;
    }
  });

  it('estimateCost uses tokenizer + price table', async () => {
    const tokenize = vi.fn().mockReturnValue(2_000);
    const provider = createOpenAIProvider(
      { type: 'openai', model: 'gpt-4o', apiKey: 'k' },
      { tokenize, createClient: vi.fn().mockReturnValue(() => ({})) },
    );
    const r = await provider.estimateCost(baseInput);
    expect(r.inputTokens).toBe(2_000);
    expect(r.estimatedUsd).toBeCloseTo((2_000 / 1_000_000) * 2.5, 6);
    expect(tokenize).toHaveBeenCalledOnce();
  });

  it('pricePerMillionTokens returns gpt-4o prices', () => {
    const provider = createOpenAIProvider(
      { type: 'openai', model: 'gpt-4o', apiKey: 'k' },
      { createClient: vi.fn().mockReturnValue(() => ({})) },
    );
    expect(provider.pricePerMillionTokens()).toEqual({ input: 2.5, output: 10 });
  });

  it('generateReview computes cost from usage tokens', async () => {
    const generate = vi.fn().mockResolvedValue({
      experimental_output: { comments: [], summary: 'ok' },
      totalUsage: { inputTokens: 1000, outputTokens: 500 },
      steps: [],
    });
    const provider = createOpenAIProvider(
      { type: 'openai', model: 'gpt-4o-mini', apiKey: 'k' },
      {
        createClient: vi.fn().mockReturnValue(() => ({ id: 'mock-model' })),
        generate,
        tokenize: () => 0,
      },
    );
    const out = await provider.generateReview(baseInput);
    expect(out.tokensUsed).toEqual({ input: 1000, output: 500 });
    expect(out.costUsd).toBeCloseTo((1000 / 1_000_000) * 0.15 + (500 / 1_000_000) * 0.6, 6);
    expect(out.summary).toBe('ok');
    expect(generate).toHaveBeenCalledOnce();
  });

  it('generateReview forwards tools and stopWhen to generateText', async () => {
    const generate = vi.fn().mockResolvedValue({
      experimental_output: { comments: [], summary: 'ok' },
      totalUsage: { inputTokens: 1, outputTokens: 1 },
      steps: [{ toolCalls: [{ toolName: 'read_file' }] }],
    });
    const fakeTools = { read_file: { execute: () => 'x' } } as unknown as Parameters<
      typeof generate
    >[0]['tools'];
    const provider = createOpenAIProvider(
      { type: 'openai', model: 'gpt-4o', apiKey: 'k' },
      {
        createClient: vi.fn().mockReturnValue(() => ({ id: 'm' })),
        generate,
        tokenize: () => 0,
      },
    );
    const out = await provider.generateReview({
      ...baseInput,
      tools: fakeTools as never,
      maxToolCalls: 7,
    });
    const call = generate.mock.calls[0]?.[0];
    expect(call?.tools).toBe(fakeTools);
    expect(typeof call?.stopWhen).toBe('function');
    expect(call?.experimental_output).toBeDefined();
    expect(out.toolCalls).toBe(1);
  });
});
