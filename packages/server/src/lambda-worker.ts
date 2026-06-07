import type { VCS } from '@review-agent/core';
import { type JobMessage, JobMessageSchema } from '@review-agent/core';
import type { NotificationDispatcher } from './notification/index.js';
import { classifyError } from './queue/error-classifier.js';
import type { JobHandler } from './worker.js';

type SQSRecord = {
  messageId: string;
  body: string;
  receiptHandle: string;
};

type SQSEvent = {
  Records: ReadonlyArray<SQSRecord>;
};

type SQSBatchResponse = {
  batchItemFailures: Array<{ itemIdentifier: string }>;
};

export type LambdaWorkerLogger = {
  error(message: string, ctx?: Record<string, unknown>): void;
  warn(message: string, ctx?: Record<string, unknown>): void;
};

export type LambdaWorkerOpts = {
  readonly handler: JobHandler;
  /**
   * Optional dependencies for permanent-failure termination (#138).
   *
   * When present, handler failures classified as **permanent** are:
   *  1. Logged at `error` level with structured context.
   *  2. Dispatched as a `job.failed` notification (fail-open).
   *  3. Written as a "FAILED:" marker to the PR state comment (fail-open).
   *  4. NOT returned in `batchItemFailures` — i.e., the message IS acked
   *     and will NOT be re-delivered or routed to the DLQ.
   *
   * Transient failures are always returned in `batchItemFailures` so SQS
   * retries and ultimately routes the message to the DLQ (existing behaviour).
   *
   * When absent, ALL handler failures are returned as `batchItemFailures`
   * (backward-compatible — the caller handles DLQ routing via SQS redrive).
   */
  readonly failureDeps?: LambdaFailureDeps;
};

export type LambdaFailureDeps = {
  readonly notifier: NotificationDispatcher;
  readonly vcs: VCS;
  readonly logger: LambdaWorkerLogger;
};

export function createSqsLambdaHandler(
  opts: LambdaWorkerOpts,
): (event: SQSEvent) => Promise<SQSBatchResponse> {
  return async (event: SQSEvent) => {
    const failures: SQSBatchResponse['batchItemFailures'] = [];
    for (const record of event.Records) {
      let parsed: JobMessage;
      try {
        parsed = JobMessageSchema.parse(JSON.parse(record.body));
      } catch {
        failures.push({ itemIdentifier: record.messageId });
        continue;
      }
      try {
        await opts.handler(parsed);
      } catch (err) {
        const handled = await handleLambdaFailure(err, parsed, opts);
        if (!handled) {
          // Transient — return to SQS for retry / DLQ routing.
          failures.push({ itemIdentifier: record.messageId });
        }
        // Permanent (handled === true) — acked; not added to batchItemFailures.
      }
    }
    return { batchItemFailures: failures };
  };
}

/**
 * Handle a Lambda handler failure with transient/permanent classification (#138).
 *
 * Returns `true` when the error was classified as **permanent** AND the
 * termination side-effects (notify + state comment) were attempted. The
 * caller should NOT add the message to `batchItemFailures` in that case.
 *
 * Returns `false` when the error is **transient** or `failureDeps` is absent,
 * meaning the caller should add the message to `batchItemFailures` so SQS
 * can retry and eventually route to the DLQ.
 */
async function handleLambdaFailure(
  err: unknown,
  msg: JobMessage,
  opts: LambdaWorkerOpts,
): Promise<boolean> {
  const failureClass = classifyError(err);
  const errMsg = err instanceof Error ? err.message : String(err);
  const { failureDeps } = opts;

  if (failureClass === 'transient' || failureDeps === undefined) {
    // Transient or no deps wired — return to SQS batch failures for retry.
    failureDeps?.logger.warn(
      '[lambda-worker] transient handler failure — returning to SQS for retry/DLQ',
      {
        jobId: msg.jobId,
        repo: `${msg.prRef.owner}/${msg.prRef.repo}`,
        prNumber: msg.prRef.number,
        failureClass,
        error: errMsg,
      },
    );
    return false;
  }

  // Permanent failure: terminate the job without re-delivery.
  const { notifier, vcs, logger } = failureDeps;
  const repo = `${msg.prRef.owner}/${msg.prRef.repo}`;
  const prNumber = msg.prRef.number;

  logger.error('[lambda-worker] permanent handler failure — terminating job', {
    jobId: msg.jobId,
    repo,
    prNumber,
    failureClass,
    error: errMsg,
  });

  // 1. Dispatch job.failed notification (fail-open).
  await notifier
    .dispatch({
      type: 'job.failed',
      repo,
      installationId: msg.installationId,
      jobId: msg.jobId,
      timestamp: new Date().toISOString(),
      prNumber,
      summary: `Job failed (permanent): ${errMsg}`,
    })
    .catch((notifyErr: unknown) => {
      const notifyErrMsg = notifyErr instanceof Error ? notifyErr.message : String(notifyErr);
      logger.warn('[lambda-worker] job.failed notification dispatch failed (fail-open)', {
        jobId: msg.jobId,
        error: notifyErrMsg,
      });
    });

  // 2. Write "Review failed" marker to the PR state comment (fail-open).
  await writeLambdaFailedStateComment(vcs, msg, errMsg, logger);

  // Signal to the caller that the message should be acked (not re-delivered).
  return true;
}

/**
 * Embed a "FAILED:" marker into the PR state comment so the failure is
 * visible to operators monitoring the PR. Uses the same strategy as the
 * long-poll SQS path: update `modelUsed` in the existing (or synthesised)
 * ReviewState with a "FAILED: <reason>" prefix. Fail-open.
 */
async function writeLambdaFailedStateComment(
  vcs: VCS,
  msg: JobMessage,
  reason: string,
  logger: LambdaWorkerLogger,
): Promise<void> {
  const ref = {
    platform: msg.prRef.platform,
    owner: msg.prRef.owner,
    repo: msg.prRef.repo,
    number: msg.prRef.number,
  };

  try {
    const existing = await vcs.getStateComment(ref);
    const failedState = existing ?? {
      schemaVersion: 1 as const,
      lastReviewedSha: msg.prRef.headSha ?? 'unknown',
      baseSha: 'unknown',
      reviewedAt: new Date().toISOString(),
      modelUsed: 'unknown',
      totalTokens: 0,
      totalCostUsd: 0,
      commentFingerprints: [],
    };
    await vcs.upsertStateComment(ref, {
      ...failedState,
      reviewedAt: new Date().toISOString(),
      modelUsed: `FAILED: ${reason.slice(0, 120)}`,
    });
  } catch (stateErr: unknown) {
    const stateErrMsg = stateErr instanceof Error ? stateErr.message : String(stateErr);
    logger.warn('[lambda-worker] could not write failed state comment (fail-open)', {
      jobId: msg.jobId,
      repo: `${msg.prRef.owner}/${msg.prRef.repo}`,
      error: stateErrMsg,
    });
  }
}
