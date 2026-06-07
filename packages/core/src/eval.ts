import type { Confidence, ReviewAbortReason, Severity } from './review.js';

/**
 * Per-review summary recorded by the runner after `runReview`
 * finishes. Shape mirrors `core/db/schema/review-eval-event.ts` but
 * lives in `core` (no I/O) so the runner and the DB recorder share a
 * single source of truth.
 *
 * Added in v1.2 epic #83 Phase 2.
 */
export type ReviewEvalEvent = {
  readonly installationId: bigint;
  readonly jobId: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly headSha: string;
  readonly provider: string;
  readonly model: string;
  readonly commentCount: number;
  /** `{ critical: n, high: n, medium: n, low: n, style: n }`. */
  readonly severityDist: Readonly<Record<Severity, number>>;
  /** `{ high: n, medium: n, low: n }`. */
  readonly confidenceDist: Readonly<Record<Confidence, number>>;
  readonly droppedDuplicates: number;
  /** Always zero until Phase 4 wires the feedback-aware dedup path. */
  readonly droppedByFeedback: number;
  readonly toolCalls: number;
  readonly latencyMs: number;
  readonly costUsd: number;
  readonly tokensInput: number;
  readonly tokensOutput: number;
  readonly abortReason: ReviewAbortReason | null;
  /**
   * Total files in the PR diff after path-filter exclusions (universe the
   * runner was asked to review). Null when not computable (back-compat).
   */
  readonly filesTotal?: number | null;
  /**
   * Files actually handed to the LLM. Equals `filesTotal` minus any files
   * excluded by max_files / max_diff_lines / max_chunks / budget caps.
   * Null when not computable (back-compat).
   */
  readonly filesReviewed?: number | null;
};

export type ReviewEvalEventRecorder = (event: ReviewEvalEvent) => Promise<void>;
