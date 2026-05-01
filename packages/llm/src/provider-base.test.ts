import { describe, expect, it } from 'vitest';
import { classifyHttpStyleError, composeUserPrompt } from './provider-base.js';
import type { ReviewInput } from './types.js';

describe('composeUserPrompt', () => {
  it('wraps PR metadata in <untrusted> + diff in <diff>', () => {
    const input: ReviewInput = {
      systemPrompt: 'sys',
      diffText: '--- a/x\n+++ b/x',
      prMetadata: { title: 'T', body: 'B', author: 'a' },
      fileReader: async () => '',
      language: 'en-US',
    };
    const out = composeUserPrompt(input);
    expect(out).toContain('<untrusted>');
    expect(out).toContain('<title>T</title>');
    expect(out).toContain('<author>a</author>');
    expect(out).toContain('<body>B</body>');
    expect(out).toContain('</untrusted>');
    expect(out).toContain('<diff>');
    expect(out).toContain('--- a/x');
    expect(out).toContain('</diff>');
  });
});

describe('classifyHttpStyleError', () => {
  it('classifies 429 with retry-after-ms header', () => {
    const result = classifyHttpStyleError({
      status: 429,
      headers: { 'retry-after-ms': '500' },
    });
    expect(result).toEqual({ kind: 'rate_limit', retryAfterMs: 500 });
  });

  it('classifies 429 with retry-after seconds header', () => {
    const result = classifyHttpStyleError({
      statusCode: 429,
      headers: { 'retry-after': '2' },
    });
    expect(result).toEqual({ kind: 'rate_limit', retryAfterMs: 2000 });
  });

  it('classifies 429 with no headers', () => {
    expect(classifyHttpStyleError({ status: 429 })).toEqual({ kind: 'rate_limit' });
  });

  it('classifies 500 / 503 as overloaded', () => {
    expect(classifyHttpStyleError({ status: 500 })).toEqual({ kind: 'overloaded' });
    expect(classifyHttpStyleError({ status: 503 })).toEqual({ kind: 'overloaded' });
  });

  it('classifies 401 / 403 as auth', () => {
    expect(classifyHttpStyleError({ status: 401 })).toEqual({ kind: 'auth' });
    expect(classifyHttpStyleError({ status: 403 })).toEqual({ kind: 'auth' });
  });

  it('classifies the OpenAI context_length_exceeded code', () => {
    expect(classifyHttpStyleError({ code: 'context_length_exceeded' })).toEqual({
      kind: 'context_length',
    });
  });

  it('classifies "exceeds context window" message string as context_length', () => {
    expect(
      classifyHttpStyleError({ message: 'request tokens exceeds the model context window' }),
    ).toEqual({ kind: 'context_length' });
  });

  it('classifies known network error codes as transient', () => {
    expect(classifyHttpStyleError({ code: 'ECONNRESET' })).toEqual({ kind: 'transient' });
    expect(classifyHttpStyleError({ code: 'ETIMEDOUT' })).toEqual({ kind: 'transient' });
  });

  it('falls back to fatal for unrecognised errors', () => {
    expect(classifyHttpStyleError({ status: 418 })).toEqual({ kind: 'fatal' });
    expect(classifyHttpStyleError(null)).toEqual({ kind: 'fatal' });
    expect(classifyHttpStyleError(new Error('boom'))).toEqual({ kind: 'fatal' });
  });
});
