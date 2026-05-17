import { describe, expect, it, vi } from 'vitest';
import { type RetryClassifier, withRetry } from './retry.js';

const noSleep = async (_ms: number) => undefined;

const alwaysRetry =
  (delayMs = 0): RetryClassifier =>
  () => ({ retry: true, delayMs });

const neverRetry: RetryClassifier = () => ({ retry: false });

describe('withRetry', () => {
  it('returns the first-attempt result and never calls classify on success', async () => {
    const classify = vi.fn(alwaysRetry());
    const fn = vi.fn(async () => 'ok');
    const result = await withRetry(fn, { classify, sleep: noSleep, maxAttempts: 5 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(classify).not.toHaveBeenCalled();
  });

  it('retries while the classifier asks for it, then resolves once fn succeeds', async () => {
    let call = 0;
    const fn = vi.fn(async () => {
      call += 1;
      if (call < 3) throw new Error('boom');
      return 'ok';
    });
    const result = await withRetry(fn, {
      classify: alwaysRetry(),
      sleep: noSleep,
      maxAttempts: 5,
    });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('does NOT retry when the classifier returns `{ retry: false }` and rethrows the original error', async () => {
    const err = new Error('nope');
    const fn = vi.fn(async () => {
      throw err;
    });
    await expect(withRetry(fn, { classify: neverRetry, sleep: noSleep })).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('throws the classifier-supplied `throwAs` instead of the underlying error', async () => {
    const original = new Error('raw');
    const substitute = new Error('mapped');
    const fn = vi.fn(async () => {
      throw original;
    });
    await expect(
      withRetry(fn, { classify: () => ({ retry: false, throwAs: substitute }), sleep: noSleep }),
    ).rejects.toBe(substitute);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('respects maxAttempts as an absolute cap when the classifier keeps saying retry', async () => {
    const err = new Error('still down');
    const fn = vi.fn(async () => {
      throw err;
    });
    await expect(
      withRetry(fn, { classify: alwaysRetry(), sleep: noSleep, maxAttempts: 4 }),
    ).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it('defaults maxAttempts to 10 when omitted', async () => {
    const err = new Error('still down');
    const fn = vi.fn(async () => {
      throw err;
    });
    await expect(withRetry(fn, { classify: alwaysRetry(), sleep: noSleep })).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(10);
  });

  it('treats maxAttempts <= 0 as 1 (one shot, no retry)', async () => {
    const sleep = vi.fn(noSleep);
    const err = new Error('boom');
    const fn = vi.fn(async () => {
      throw err;
    });
    await expect(withRetry(fn, { classify: alwaysRetry(), sleep, maxAttempts: 0 })).rejects.toBe(
      err,
    );
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('sleeps with the classifier-supplied delay between attempts, never after the last', async () => {
    const sleep = vi.fn(noSleep);
    const delays = [10, 30, 90, 90];
    const classify: RetryClassifier = (_err, attempt) => ({
      retry: true,
      delayMs: delays[attempt] ?? 0,
    });
    const fn = vi.fn(async () => {
      throw new Error('boom');
    });
    await expect(withRetry(fn, { classify, sleep, maxAttempts: 3 })).rejects.toBeDefined();
    // 3 attempts → 2 sleeps (after attempts 0 and 1); attempt 2 hits
    // the hard cap so its delay is never observed.
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([10, 30]);
  });

  it('passes the zero-based attempt index to the classifier', async () => {
    const classify = vi.fn(alwaysRetry(0));
    const fn = vi.fn(async () => {
      throw new Error('boom');
    });
    await expect(withRetry(fn, { classify, sleep: noSleep, maxAttempts: 4 })).rejects.toBeDefined();
    const attempts = classify.mock.calls.map((c) => c[1]);
    expect(attempts).toEqual([0, 1, 2, 3]);
  });

  it('rethrows synchronously-classifier-rejected errors without sleeping', async () => {
    // A classifier that says "no retry" on attempt 0 must not produce
    // a sleep call even if the schedule would otherwise allow it.
    const sleep = vi.fn(noSleep);
    const err = new Error('non-retriable');
    const fn = vi.fn(async () => {
      throw err;
    });
    await expect(withRetry(fn, { classify: neverRetry, sleep, maxAttempts: 5 })).rejects.toBe(err);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('uses a default sleep when none is injected (real-timer smoke test)', async () => {
    // We can't realistically wait for arbitrary delays in CI, but we
    // can verify the default sleep path runs on a tiny delay and the
    // overall call still resolves through `fn`'s eventual success.
    let call = 0;
    const fn = vi.fn(async () => {
      call += 1;
      if (call === 1) throw new Error('once');
      return 'ok';
    });
    const result = await withRetry(fn, {
      classify: alwaysRetry(0),
      maxAttempts: 2,
    });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('throws the last error after the cap is reached, not the first', async () => {
    const errors = [new Error('e0'), new Error('e1'), new Error('e2')];
    let call = 0;
    const fn = vi.fn(async () => {
      const err = errors[call] ?? errors[errors.length - 1];
      call += 1;
      throw err;
    });
    await expect(
      withRetry(fn, { classify: alwaysRetry(), sleep: noSleep, maxAttempts: 3 }),
    ).rejects.toBe(errors[2]);
  });
});
