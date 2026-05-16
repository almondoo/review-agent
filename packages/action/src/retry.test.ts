import { describe, expect, it, vi } from 'vitest';
import { isRetriable, withRetry } from './retry.js';

const noSleep = async (_ms: number) => undefined;

describe('isRetriable', () => {
  it('treats 5xx as retriable', () => {
    expect(isRetriable({ status: 500 })).toBe(true);
    expect(isRetriable({ status: 502 })).toBe(true);
    expect(isRetriable({ status: 599 })).toBe(true);
  });

  it('treats 429 as retriable', () => {
    expect(isRetriable({ status: 429 })).toBe(true);
  });

  it('treats other 4xx as non-retriable', () => {
    expect(isRetriable({ status: 400 })).toBe(false);
    expect(isRetriable({ status: 401 })).toBe(false);
    expect(isRetriable({ status: 403 })).toBe(false);
    expect(isRetriable({ status: 404 })).toBe(false);
    expect(isRetriable({ status: 422 })).toBe(false);
  });

  it('reads status from .response.status when present', () => {
    expect(isRetriable({ response: { status: 503 } })).toBe(true);
    expect(isRetriable({ response: { status: 404 } })).toBe(false);
  });

  it('treats non-HTTP errors as retriable (transient by default)', () => {
    expect(isRetriable(new Error('ECONNRESET'))).toBe(true);
    expect(isRetriable(null)).toBe(true);
    expect(isRetriable('string err')).toBe(true);
  });

  it("treats 2xx/3xx as retriable (shouldn't happen but is not a 4xx)", () => {
    expect(isRetriable({ status: 200 })).toBe(true);
    expect(isRetriable({ status: 304 })).toBe(true);
  });
});

describe('withRetry', () => {
  it('returns immediately on first-attempt success', async () => {
    const fn = vi.fn(async () => 'ok');
    const result = await withRetry(fn, { attempts: 3, label: 'x', sleep: noSleep });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries a retriable failure and resolves once succeeded', async () => {
    let call = 0;
    const fn = vi.fn(async () => {
      call += 1;
      if (call < 3) throw Object.assign(new Error('boom'), { status: 503 });
      return 'ok';
    });
    const result = await withRetry(fn, { attempts: 3, label: 'x', sleep: noSleep });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('does NOT retry on a non-retriable error (4xx other than 429)', async () => {
    const err = Object.assign(new Error('nope'), { status: 404 });
    const fn = vi.fn(async () => {
      throw err;
    });
    await expect(withRetry(fn, { attempts: 5, label: 'x', sleep: noSleep })).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('throws the last error when retries are exhausted', async () => {
    const err = Object.assign(new Error('still down'), { status: 502 });
    const fn = vi.fn(async () => {
      throw err;
    });
    await expect(withRetry(fn, { attempts: 3, label: 'x', sleep: noSleep })).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('uses the configured backoff delays and does NOT sleep after the last attempt', async () => {
    const sleep = vi.fn(noSleep);
    const fn = vi.fn(async () => {
      throw Object.assign(new Error('502'), { status: 502 });
    });
    await expect(
      withRetry(fn, {
        attempts: 3,
        label: 'x',
        sleep,
        delaysMs: [10, 30, 90],
      }),
    ).rejects.toBeDefined();
    // 3 attempts → 2 sleeps (between 1↔2 and 2↔3); none after attempt 3.
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([10, 30]);
  });

  it('logs each retry with attempt index, label, and the error message', async () => {
    const logger = vi.fn();
    let call = 0;
    const fn = vi.fn(async () => {
      call += 1;
      if (call === 1) throw Object.assign(new Error('first fail'), { status: 503 });
      return 'ok';
    });
    await withRetry(fn, {
      attempts: 3,
      label: 'upsertStateComment',
      sleep: noSleep,
      logger,
    });
    expect(logger).toHaveBeenCalledOnce();
    const [msg, meta] = logger.mock.calls[0] ?? [];
    expect(msg).toContain('upsertStateComment');
    expect(msg).toContain('attempt 1/3');
    expect(meta).toMatchObject({ error: 'first fail', status: 503 });
  });

  it('treats attempts=1 as single-shot (no retry, no sleep)', async () => {
    const sleep = vi.fn(noSleep);
    const err = Object.assign(new Error('502'), { status: 502 });
    const fn = vi.fn(async () => {
      throw err;
    });
    await expect(withRetry(fn, { attempts: 1, label: 'x', sleep })).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('throws on attempts <= 0 (caller should skip upstream)', async () => {
    await expect(() =>
      withRetry(async () => 'ok', { attempts: 0, label: 'x', sleep: noSleep }),
    ).rejects.toThrow(/attempts must be >= 1/);
  });

  it('caps attempts at 10 to bound worst-case retry storms', async () => {
    const fn = vi.fn(async () => {
      throw Object.assign(new Error('502'), { status: 502 });
    });
    await expect(
      withRetry(fn, {
        attempts: 999,
        label: 'x',
        sleep: noSleep,
        delaysMs: [1, 1, 1, 1, 1, 1, 1, 1, 1],
      }),
    ).rejects.toBeDefined();
    expect(fn).toHaveBeenCalledTimes(10);
  });

  it('honors an injected isRetriable classifier', async () => {
    // Force-treat 404 as retriable to prove the override wires through.
    const err = Object.assign(new Error('404'), { status: 404 });
    let call = 0;
    const fn = vi.fn(async () => {
      call += 1;
      if (call < 2) throw err;
      return 'ok';
    });
    const result = await withRetry(fn, {
      attempts: 3,
      label: 'x',
      sleep: noSleep,
      isRetriable: () => true,
    });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('falls back to the last entry of delaysMs when retry index exceeds the schedule', async () => {
    const sleep = vi.fn(noSleep);
    const fn = vi.fn(async () => {
      throw Object.assign(new Error('502'), { status: 502 });
    });
    await expect(
      withRetry(fn, {
        attempts: 5,
        label: 'x',
        sleep,
        delaysMs: [1, 2],
      }),
    ).rejects.toBeDefined();
    // 5 attempts → 4 sleeps; the schedule has 2 entries, so retries
    // 0 and 1 use 1ms and 2ms, retries 2 and 3 reuse the last (2ms).
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([1, 2, 2, 2]);
  });
});
