/**
 * Error classifier for queue-level failure handling (#138).
 *
 * Distinguishes between errors that are worth retrying (transient) and
 * those that will never succeed regardless of how many times the job is
 * attempted (permanent).
 *
 * ## Policy for unknown errors
 *
 * Unknown errors are classified as **transient** (the safe side for retries).
 * Rationale: an unknown error might be a transient infrastructure blip that
 * SQS visibility-timeout retry can recover from. Treating it as permanent
 * would silently drop the job, potentially causing a missed review that the
 * user is unaware of. The downside of treating an unknown permanent error as
 * transient is a few extra retries before the message lands in the DLQ, after
 * which the DLQ processor fires the `job.failed` notification anyway. That
 * cost is acceptable: extra SQS retries are cheap; a silently dropped job is
 * not.
 *
 * ## Import note
 * This module deliberately does NOT import from `@review-agent/llm` — that
 * package is not a dependency of `@review-agent/server`. The LLM error kinds
 * are matched structurally (duck-typing) against a local copy of the known
 * kind strings. If new kinds are added to `@review-agent/llm`, update
 * `LLM_ERROR_KINDS` here accordingly.
 */

import { ReviewAgentError } from '@review-agent/core';

/** The two mutually exclusive retry behaviours. */
export type FailureClass = 'transient' | 'permanent';

/**
 * LLM provider error kinds — must stay in sync with `ERROR_KINDS` in
 * `packages/llm/src/types.ts`.
 */
const LLM_TRANSIENT_KINDS = new Set(['rate_limit', 'overloaded', 'transient']);
const LLM_PERMANENT_KINDS = new Set(['auth', 'fatal', 'context_length']);
const ALL_LLM_KINDS = new Set([...LLM_TRANSIENT_KINDS, ...LLM_PERMANENT_KINDS]);

/**
 * Classify an arbitrary thrown value as transient or permanent.
 *
 * - **transient** → let SQS visibility timeout handle retry; after
 *   `maxReceiveCount` the message lands in the DLQ.
 * - **permanent** → retrying will not help; terminate the job immediately,
 *   dispatch `job.failed`, and ack the message (no re-delivery).
 */
export function classifyError(err: unknown): FailureClass {
  // LLM provider errors — matched structurally by the `kind` string.
  if (isLlmProviderError(err)) {
    const kind = err.kind;
    if (LLM_TRANSIENT_KINDS.has(kind)) return 'transient';
    if (LLM_PERMANENT_KINDS.has(kind)) return 'permanent';
    // Unknown LLM kind — default to transient (see module-level policy).
    return 'transient';
  }

  // ReviewAgentError subclasses — errors thrown from within the review pipeline.
  if (err instanceof ReviewAgentError) {
    switch (err.kind) {
      case 'cost-exceeded':
      case 'context-length':
      case 'config':
      case 'schema':
        return 'permanent';
      case 'tool-dispatch-refused':
      case 'secret-leak-aborted':
      case 'gitleaks-scan-failed':
        // These are operator / security policy violations. Retrying will not
        // help — the same input will produce the same refusal.
        return 'permanent';
      default: {
        // Exhaustiveness guard — new ReviewAgentErrorKind values added to
        // @review-agent/core should be evaluated here. Until then, default to
        // transient (safe side).
        const _exhaustive: never = err.kind;
        void _exhaustive;
        return 'transient';
      }
    }
  }

  // Unknown error — default to transient (see module-level policy comment).
  return 'transient';
}

/**
 * Type guard: checks whether `err` carries a `kind` string that matches one
 * of the known LLM `ErrorKind` values. We match structurally (duck-typing)
 * rather than `instanceof` because `@review-agent/llm` is not a dependency
 * of `@review-agent/server`. Providers embed the kind on the thrown error
 * object by convention.
 */
function isLlmProviderError(err: unknown): err is { kind: string } {
  if (typeof err !== 'object' || err === null) return false;
  const kind = (err as Record<string, unknown>).kind;
  if (typeof kind !== 'string') return false;
  return ALL_LLM_KINDS.has(kind);
}
