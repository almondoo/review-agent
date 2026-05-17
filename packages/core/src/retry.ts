// Provider-agnostic retry loop. Both the GitHub-API state-comment
// writes in `@review-agent/action` and the LLM driver calls in
// `@review-agent/llm` previously shipped their own near-identical
// implementations: same try/catch shape, same classifier-driven retry
// decision, same sleep-then-retry rhythm. They are folded into this
// one generic loop so the two cannot drift; the package-specific bits
// (HTTP status classification vs `LlmProvider.classifyError`, [1,3,9]s
// vs exponential-with-jitter schedules, retry-after honoring) are
// expressed entirely through the classifier callback each caller
// supplies.
//
// `core` keeps its zero-I/O contract: this module performs no fetches
// and no filesystem access. The only side-effect is `sleep`, which is
// injectable so tests can run without real delays.

/**
 * The classifier decides — for a single failure — whether to retry,
 * how long to wait first, and (optionally) what error to throw
 * **instead** of the original. Pure-ish: callers should treat it as a
 * decision function. Side-effects (logging, accounting) are permitted
 * but should not block; the caller is expected to do them quickly.
 *
 * `attempt` is the zero-based index of the failed call: 0 for the
 * first failure, 1 for the second, etc.
 *
 * The `throwAs` field on the no-retry result lets callers replace the
 * raw provider error with a higher-level one (e.g. mapping a "context
 * length" classification onto `ContextLengthError`) without forcing
 * the loop itself to know about that error type.
 */
export type RetryDecision =
  | { readonly retry: false; readonly throwAs?: unknown }
  | { readonly retry: true; readonly delayMs: number };

export type RetryClassifier = (err: unknown, attempt: number) => RetryDecision;

export type RetryOpts = {
  /** Classify each failure: retry-with-delay, or give up (optionally throwing a substitute error). */
  readonly classify: RetryClassifier;
  /**
   * Absolute upper bound on total attempts (including the first
   * call). Defaults to 10. The classifier can stop earlier by
   * returning `{ retry: false }`; this cap exists to prevent a
   * classifier that always says `retry: true` from looping forever.
   */
  readonly maxAttempts?: number;
  /** Injectable sleep so tests can avoid real delays. Defaults to `setTimeout`. */
  readonly sleep?: (ms: number) => Promise<void>;
};

const DEFAULT_MAX_ATTEMPTS = 10;

/**
 * Run `fn`, retrying on failures the classifier marks as retriable.
 * Resolves with the first successful result, or rejects with the last
 * underlying error (or the classifier's `throwAs` substitute, when
 * supplied). Never resolves on a failure — caller-side success/failure
 * semantics are preserved across the abstraction.
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOpts): Promise<T> {
  const max = Math.max(1, opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const sleep = opts.sleep ?? defaultSleep;

  let lastErr: unknown;
  for (let attempt = 0; attempt < max; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const decision = opts.classify(err, attempt);
      if (!decision.retry) {
        if (decision.throwAs !== undefined) throw decision.throwAs;
        throw err;
      }
      // Classifier says retry, but the absolute cap is the next stop
      // — skip the sleep and throw immediately. Without this branch,
      // the loop would sleep once more for nothing before re-checking
      // the bound on the next iteration's classify call.
      if (attempt + 1 >= max) break;
      await sleep(decision.delayMs);
    }
  }
  throw lastErr;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
