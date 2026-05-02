import { ContextLengthError } from '@review-agent/core';
import { describe, expect, it, vi } from 'vitest';
import { withRetry } from './retry.js';
import type { ErrorClassification } from './types.js';

function makeDriver(classifications: ReadonlyArray<ErrorClassification>) {
  let i = 0;
  return {
    classifyError: vi.fn(() => {
      const c = classifications[i] ?? { kind: 'fatal' as const };
      i = Math.min(i + 1, classifications.length - 1);
      return c;
    }),
  };
}

const stubDeps = (sleep = vi.fn(async () => {})) => ({ sleep, random: () => 0.5 });

describe('withRetry', () => {
  it('returns the result on first success', async () => {
    const fn = vi.fn(async () => 'ok');
    const result = await withRetry({ classifyError: () => ({ kind: 'fatal' }) }, fn, stubDeps());
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on rate_limit up to 5 attempts and surfaces the underlying error', async () => {
    const driver = makeDriver([{ kind: 'rate_limit' }]);
    const sleep = vi.fn(async () => {});
    const err = new Error('429');
    const fn = vi.fn(async () => {
      throw err;
    });
    await expect(withRetry(driver, fn, { sleep, random: () => 0.5 })).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(6);
  });

  it('honors retryAfterMs from classification', async () => {
    const driver = {
      classifyError: vi.fn(() => ({ kind: 'rate_limit' as const, retryAfterMs: 7000 })),
    };
    const sleep = vi.fn(async () => {});
    const fn = vi
      .fn<() => Promise<'ok'>>()
      .mockRejectedValueOnce(new Error('429'))
      .mockResolvedValueOnce('ok');
    const result = await withRetry(driver, fn, { sleep, random: () => 0.5 });
    expect(result).toBe('ok');
    expect(sleep).toHaveBeenCalledWith(7000);
  });

  it('uses exponential backoff when retryAfterMs is absent', async () => {
    const driver = { classifyError: vi.fn(() => ({ kind: 'rate_limit' as const })) };
    const sleep = vi.fn(async () => {});
    const fn = vi
      .fn<() => Promise<'ok'>>()
      .mockRejectedValueOnce(new Error('429'))
      .mockRejectedValueOnce(new Error('429'))
      .mockResolvedValueOnce('ok');
    await withRetry(driver, fn, { sleep, random: () => 0.5 });
    expect(sleep).toHaveBeenNthCalledWith(1, 1000);
    expect(sleep).toHaveBeenNthCalledWith(2, 2000);
  });

  it('throws ContextLengthError on context_length classification (no retry)', async () => {
    const driver = { classifyError: vi.fn(() => ({ kind: 'context_length' as const })) };
    const fn = vi.fn(async () => {
      throw new Error('too long');
    });
    await expect(withRetry(driver, fn, stubDeps())).rejects.toBeInstanceOf(ContextLengthError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('rethrows immediately on auth (no retry)', async () => {
    const driver = { classifyError: vi.fn(() => ({ kind: 'auth' as const })) };
    const err = new Error('401');
    const fn = vi.fn(async () => {
      throw err;
    });
    await expect(withRetry(driver, fn, stubDeps())).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('rethrows immediately on fatal (no retry)', async () => {
    const driver = { classifyError: vi.fn(() => ({ kind: 'fatal' as const })) };
    const err = new Error('boom');
    const fn = vi.fn(async () => {
      throw err;
    });
    await expect(withRetry(driver, fn, stubDeps())).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries overloaded up to 3 attempts and surfaces the underlying error', async () => {
    const driver = { classifyError: vi.fn(() => ({ kind: 'overloaded' as const })) };
    const err = new Error('529');
    const fn = vi.fn(async () => {
      throw err;
    });
    await expect(withRetry(driver, fn, stubDeps())).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it('retries transient up to 3 attempts and surfaces the underlying error', async () => {
    const driver = { classifyError: vi.fn(() => ({ kind: 'transient' as const })) };
    const err = new Error('network');
    const fn = vi.fn(async () => {
      throw err;
    });
    await expect(withRetry(driver, fn, stubDeps())).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(4);
  });
});
