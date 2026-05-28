import {
  CONFIDENCES,
  type Confidence,
  type InlineComment,
  type ReviewAbortReason,
  type ReviewEvalEvent,
  type ReviewEvalEventRecorder,
  SEVERITIES,
  type Severity,
} from '@review-agent/core';
import type { RunnerResult } from '../types.js';

/**
 * Per-review evaluation event hook (spec v1.2 epic #83 Phase 2).
 * The runner builds a `ReviewEvalEvent` from the final
 * `RunnerResult` and calls this hook once at the very end of
 * `runReview`. Insert errors are caught here (fail-open) so a
 * transient DB issue never crashes a successfully-posted review —
 * the operator sees the comments and the eval row is silently
 * dropped. A `onRecordError` callback fans the failure out to
 * OTel / logger for the operator who does want the signal.
 */
export type EvalRecorderContext = {
  readonly installationId: bigint;
  readonly jobId: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly headSha: string;
};

export type EvalRecorderOptions = {
  readonly recorder: ReviewEvalEventRecorder;
  readonly context: EvalRecorderContext;
  readonly onRecordError?: (err: unknown) => void;
};

function emptySeverityDist(): Record<Severity, number> {
  return SEVERITIES.reduce<Record<Severity, number>>(
    (acc, s) => {
      acc[s] = 0;
      return acc;
    },
    {} as Record<Severity, number>,
  );
}

function emptyConfidenceDist(): Record<Confidence, number> {
  return CONFIDENCES.reduce<Record<Confidence, number>>(
    (acc, c) => {
      acc[c] = 0;
      return acc;
    },
    {} as Record<Confidence, number>,
  );
}

/**
 * Build the per-review eval event from the final runner result. The
 * `confidence` field on `InlineComment` is optional; comments that
 * omit it are counted under `'high'` per the runtime's
 * `meetsConfidence` convention (legacy reviews are not silently
 * demoted by tightening `min_confidence`).
 */
export function buildReviewEvalEvent(
  ctx: EvalRecorderContext,
  result: RunnerResult,
  latencyMs: number,
): ReviewEvalEvent {
  const severityDist = emptySeverityDist();
  const confidenceDist = emptyConfidenceDist();
  for (const c of result.comments as ReadonlyArray<InlineComment>) {
    /* v8 ignore next */
    severityDist[c.severity] = (severityDist[c.severity] ?? 0) + 1;
    const conf = c.confidence ?? 'high';
    /* v8 ignore next */
    confidenceDist[conf] = (confidenceDist[conf] ?? 0) + 1;
  }
  const abortReason: ReviewAbortReason | null = result.aborted?.reason ?? null;
  return {
    installationId: ctx.installationId,
    jobId: ctx.jobId,
    repo: ctx.repo,
    prNumber: ctx.prNumber,
    headSha: ctx.headSha,
    provider: result.provider,
    model: result.model,
    commentCount: result.comments.length,
    severityDist,
    confidenceDist,
    droppedDuplicates: result.droppedDuplicates,
    droppedByFeedback: result.droppedByFeedback ?? 0,
    toolCalls: result.toolCalls,
    latencyMs,
    costUsd: result.costUsd,
    tokensInput: result.tokensUsed.input,
    tokensOutput: result.tokensUsed.output,
    abortReason,
  };
}

/**
 * Fire-and-forget recorder invocation. Always resolves; errors are
 * routed through `onRecordError` so the runner's success path is
 * never aborted by a transient eval insert failure (the review
 * comments are already posted by the time this fires).
 */
export async function recordEvalEvent(
  opts: EvalRecorderOptions,
  result: RunnerResult,
  latencyMs: number,
): Promise<void> {
  const event = buildReviewEvalEvent(opts.context, result, latencyMs);
  try {
    await opts.recorder(event);
  } catch (err) {
    opts.onRecordError?.(err);
  }
}
