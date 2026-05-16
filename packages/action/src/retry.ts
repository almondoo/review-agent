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

const DEFAULT_DELAYS_MS: ReadonlyArray<number> = [1000, 3000, 9000, 9000, 9000];

export function isRetriable(err: unknown): boolean {
  const status = extractStatus(err);
  if (status === null) return true;
  if (status === 429) return true;
  if (status >= 500 && status < 600) return true;
  if (status >= 400 && status < 500) return false;
  return true;
}

function extractStatus(err: unknown): number | null {
  if (err && typeof err === 'object') {
    const candidate = (err as { status?: unknown }).status;
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return candidate;
    // Some Octokit wrappers expose status via .response.status
    const response = (err as { response?: { status?: unknown } }).response;
    if (response && typeof response === 'object') {
      const inner = response.status;
      if (typeof inner === 'number' && Number.isFinite(inner)) return inner;
    }
  }
  return null;
}

function extractMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return String(err);
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
  const sleep = opts.sleep ?? defaultSleep;
  const log = opts.logger ?? (() => undefined);
  const classify = opts.isRetriable ?? isRetriable;

  let lastErr: unknown;
  for (let i = 0; i < total; i += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const isLast = i === total - 1;
      if (!classify(err) || isLast) {
        break;
      }
      const delayIdx = Math.min(i, delays.length - 1);
      const delay = delays[delayIdx] ?? 0;
      log(`${opts.label}: attempt ${i + 1}/${total} failed; retrying in ${delay}ms`, {
        error: extractMessage(err),
        status: extractStatus(err),
      });
      await sleep(delay);
    }
  }
  throw lastErr;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
