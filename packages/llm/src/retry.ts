// LLM-side retry: provider drivers classify each failure into a kind
// (`rate_limit` / `overloaded` / `transient` / `auth` / `fatal` /
// `context_length`), this module turns that classification into a
// concrete retry / give-up decision and a backoff delay.
//
// The retry mechanics (try, catch, classify, sleep, repeat, throw last
// error) live in `@review-agent/core/retry`. This module supplies the
// LLM-specific policy via the classifier callback: per-kind attempt
// limits, exponential-with-jitter backoff schedule, and the
// `context_length` → `ContextLengthError` mapping.

import {
  ContextLengthError,
  withRetry as coreWithRetry,
  type RetryDecision,
} from '@review-agent/core';
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

// Absolute safety cap for the core loop. The classifier reaches
// `{ retry: false }` first for every well-behaved kind (limits above),
// but core needs *some* bound so a mis-behaving classifier cannot run
// forever. `max(RETRY_LIMITS) + 1` covers initial-call + worst-case
// retry count.
const MAX_ATTEMPTS = Math.max(...Object.values(RETRY_LIMITS)) + 1;

export type RetryDeps = {
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
};

export async function withRetry<T>(
  driver: Pick<LlmProvider, 'classifyError'>,
  fn: () => Promise<T>,
  deps: RetryDeps = {},
): Promise<T> {
  const random = deps.random ?? Math.random;
  return coreWithRetry(fn, {
    maxAttempts: MAX_ATTEMPTS,
    ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }),
    classify: (err, attempt): RetryDecision => {
      const { kind, retryAfterMs } = driver.classifyError(err);
      if (kind === 'auth' || kind === 'fatal') return { retry: false };
      if (kind === 'context_length') {
        return { retry: false, throwAs: new ContextLengthError(0, 0, { cause: err }) };
      }
      const limit = RETRY_LIMITS[kind];
      if (attempt >= limit) return { retry: false };
      // `retryAfterMs` from the provider (Retry-After header on 429)
      // wins over the local schedule — the provider knows when it
      // wants us back. Otherwise fall through to exponential.
      const base = retryAfterMs ?? BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)] ?? 16000;
      const jitter = base * JITTER * (random() * 2 - 1);
      return { retry: true, delayMs: Math.max(0, base + jitter) };
    },
  });
}
