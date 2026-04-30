import { ContextLengthError } from '@review-agent/core';
import type { ErrorKind, LlmProvider } from './types.js';

const RETRY_LIMITS: Readonly<
  Record<Exclude<ErrorKind, 'auth' | 'fatal' | 'context_length'>, number>
> = {
  rate_limit: 5,
  overloaded: 3,
  transient: 3,
};

const BACKOFF_MS = [1000, 2000, 4000, 8000, 16000] as const;
const JITTER = 0.2;

export type RetryDeps = {
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
};

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export async function withRetry<T>(
  driver: Pick<LlmProvider, 'classifyError'>,
  fn: () => Promise<T>,
  deps: RetryDeps = {},
): Promise<T> {
  const sleep = deps.sleep ?? defaultSleep;
  const random = deps.random ?? Math.random;
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err) {
      const { kind, retryAfterMs } = driver.classifyError(err);
      if (kind === 'auth' || kind === 'fatal') throw err;
      if (kind === 'context_length') {
        throw new ContextLengthError(0, 0, { cause: err });
      }
      const limit = RETRY_LIMITS[kind];
      if (attempt >= limit) throw err;
      const base = retryAfterMs ?? BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)] ?? 16000;
      const jitter = base * JITTER * (random() * 2 - 1);
      await sleep(Math.max(0, base + jitter));
      attempt++;
    }
  }
}
