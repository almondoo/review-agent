import type { ReviewEvalEvent, ReviewEvalEventRecorder } from '@review-agent/core';
import { type NewReviewEvalEventRow, reviewEvalEvent } from '@review-agent/core/db';
import type { DbClient } from './connection.js';

/**
 * Per-review eval event recorder backed by the `review_eval_event`
 * table (spec v1.2 epic #83 Phase 2). The runner calls this at the
 * very end of `runReview` with a fully-built `ReviewEvalEvent`. The
 * recorder is `fail-open` at the caller: insert errors are caught and
 * logged by the runner so a transient DB issue never aborts a
 * successfully-posted review.
 */
export function createReviewEvalEventRecorder(db: DbClient): ReviewEvalEventRecorder {
  return async (event: ReviewEvalEvent): Promise<void> => {
    const row: NewReviewEvalEventRow = {
      installationId: event.installationId,
      jobId: event.jobId,
      repo: event.repo,
      prNumber: event.prNumber,
      headSha: event.headSha,
      provider: event.provider,
      model: event.model,
      commentCount: event.commentCount,
      severityDist: event.severityDist,
      confidenceDist: event.confidenceDist,
      droppedDuplicates: event.droppedDuplicates,
      droppedByFeedback: event.droppedByFeedback,
      toolCalls: event.toolCalls,
      latencyMs: event.latencyMs,
      costUsd: event.costUsd,
      tokensInput: event.tokensInput,
      tokensOutput: event.tokensOutput,
      abortReason: event.abortReason,
      ...(event.filesTotal !== undefined && event.filesTotal !== null
        ? { filesTotal: event.filesTotal }
        : {}),
      ...(event.filesReviewed !== undefined && event.filesReviewed !== null
        ? { filesReviewed: event.filesReviewed }
        : {}),
    };
    await db.insert(reviewEvalEvent).values(row);
  };
}
