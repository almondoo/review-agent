// Retry helper for state-comment + post-review writes in Action mode (#62).
//
// Action runs are stateless; if the hidden state comment write fails
// transiently, the next CI push has no `lastReviewedSha` to diff
// against → full re-review → duplicate comments + double cost. We
// retry on rate-limit / 5xx so a flaky GitHub API surface doesn't
// silently corrupt the next run, and fail loud if the retry budget
// is exhausted so operators see the regression.
//
// Non-retriable: every 4xx EXCEPT 429. A 401/403/404/422 on
// `upsertStateComment` indicates a permissions / shape problem that
// retrying cannot fix.
//
// Retriable: 429, every 5xx, and any non-HTTP error (network
// disconnects, DNS hiccups). Non-HTTP errors don't carry a status
// code — they're treated as transient because GitHub API SDKs
// surface them as raw fetch errors before the HTTP layer attaches
// a status.
//
// Mechanics (the loop, sleep injection, last-error rethrow) come
// from `@review-agent/core/retry`. The package-specific bits — HTTP
// classification, [1s, 3s, 9s, 9s, 9s] schedule, status-aware log
// payload — stay here.

import { withRetry as coreWithRetry, extractMessage, extractStatus } from '@review-agent/core';

const DEFAULT_DELAYS_MS: ReadonlyArray<number> = [1000, 3000, 9000, 9000, 9000];

export function isRetriable(err: unknown): boolean {
  const status = extractStatus(err);
  if (status === null) return true;
  if (status === 429) return true;
  if (status >= 500 && status < 600) return true;
  if (status >= 400 && status < 500) return false;
  return true;
}

export type RetryLogger = (msg: string, meta?: Record<string, unknown>) => void;

export type RetryOpts = {
  /**
   * Total number of attempts including the first. `attempts: 1`
   * disables retry (single try). `attempts: 0` short-circuits and
   * throws immediately — callers should normally check `attempts > 0`
   * before invoking and decide for themselves whether skipping is
   * desired (the wrapping `runAction` does this for
   * `state-write-retries=0`).
   */
  readonly attempts: number;
  /** Human-readable label included in retry log lines. */
  readonly label: string;
  /** Injectable sleep so tests can avoid real delays. Defaults to setTimeout. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Sink for retry log lines. Tests inject a spy. */
  readonly logger?: RetryLogger;
  /** Override the default retry classifier (mostly for tests). */
  readonly isRetriable?: (err: unknown) => boolean;
  /** Override the default backoff schedule. Defaults to [1s, 3s, 9s, 9s, 9s]. */
  readonly delaysMs?: ReadonlyArray<number>;
};

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOpts): Promise<T> {
  if (opts.attempts <= 0) {
    throw new Error(
      `withRetry(${opts.label}): attempts must be >= 1; got ${opts.attempts}. ` +
        'Skip the call upstream rather than passing 0.',
    );
  }
  const total = Math.min(opts.attempts, 10);
  const delays = opts.delaysMs ?? DEFAULT_DELAYS_MS;
  const classify = opts.isRetriable ?? isRetriable;
  const logger = opts.logger;
  const label = opts.label;

  return coreWithRetry(fn, {
    maxAttempts: total,
    ...(opts.sleep === undefined ? {} : { sleep: opts.sleep }),
    classify: (err, attempt) => {
      if (!classify(err)) return { retry: false };
      const delayMs = delays[Math.min(attempt, delays.length - 1)] ?? 0;
      // Log immediately before sleep, only when a sleep will actually
      // happen — i.e. not on the final attempt, where the core loop
      // breaks via its `attempt + 1 >= max` guard without sleeping.
      // This preserves the pre-refactor "N attempts → N-1 log lines"
      // contract that the existing tests assert.
      if (attempt + 1 < total && logger !== undefined) {
        logger(`${label}: attempt ${attempt + 1}/${total} failed; retrying in ${delayMs}ms`, {
          error: extractMessage(err),
          status: extractStatus(err),
        });
      }
      return { retry: true, delayMs };
    },
  });
}
