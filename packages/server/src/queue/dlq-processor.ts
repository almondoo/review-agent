/**
 * DLQ Lambda handler (#138).
 *
 * Triggered by AWS when messages land in the dead-letter queue after
 * exhausting `maxReceiveCount` delivery attempts on the main jobs queue.
 * Each DLQ record represents a job that permanently failed to process.
 *
 * ## Responsibilities
 *  1. Parse the DLQ record body as a `JobMessage`.
 *  2. Write a "⚠️ Review failed" marker to the PR state comment so the
 *     failure is visible on the PR timeline.
 *  3. Dispatch a `job.failed` notification (fail-open — a channel error
 *     does not prevent processing other records).
 *  4. Partial failures: records that cannot be parsed are returned as
 *     `batchItemFailures` so SQS retains them in the DLQ for manual
 *     inspection.
 *
 * ## No double-counting with LLM retry (#11/§11.1)
 * The DLQ handler only fires after SQS exhausts all delivery attempts
 * (i.e. `maxReceiveCount` at the queue level). The LLM layer's built-in
 * exponential-backoff retry happens *within* a single delivery attempt; by
 * the time the message reaches the DLQ, the LLM retry has already run and
 * given up. There is no double-counting.
 *
 * ## No conflict with #16 idempotency / #62 state-comment retry
 * DLQ delivery is a separate Lambda invocation with its own SQS record. The
 * idempotency table (`webhook_deliveries`) tracks the *receiver*-side dedup
 * key (`X-GitHub-Delivery`), not worker-side job IDs. State comment upserts
 * are idempotent by design (`upsertStateComment` overwrites in-place).
 * Running the DLQ handler multiple times on the same record (SQS at-least-
 * once delivery) is safe: the state comment ends up with the same "FAILED:"
 * marker and the dispatcher's in-memory dedup key prevents duplicate
 * notifications within a single Lambda warm-container lifetime.
 */

import type { VCS } from '@review-agent/core';
import { type JobMessage, JobMessageSchema } from '@review-agent/core';
import type { NotificationDispatcher } from '../notification/index.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type DlqRecord = {
  messageId: string;
  body: string;
};

type DlqEvent = {
  Records: ReadonlyArray<DlqRecord>;
};

type SQSBatchResponse = {
  batchItemFailures: Array<{ itemIdentifier: string }>;
};

export type DlqProcessorLogger = {
  error(message: string, ctx?: Record<string, unknown>): void;
  warn(message: string, ctx?: Record<string, unknown>): void;
  info(message: string, ctx?: Record<string, unknown>): void;
};

export type DlqProcessorDeps = {
  readonly notifier: NotificationDispatcher;
  /** VCS adapter used to write the failed-state comment. */
  readonly vcs: VCS;
  readonly logger: DlqProcessorLogger;
  /** Optional override for the current timestamp (test seam). */
  readonly now?: () => Date;
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an AWS Lambda handler for the DLQ event source mapping.
 *
 * Wire this as the Lambda `handler` for your DLQ processor function:
 * ```typescript
 * export const handler = createDlqLambdaHandler({ vcs, notifier, logger });
 * ```
 */
export function createDlqLambdaHandler(
  deps: DlqProcessorDeps,
): (event: DlqEvent) => Promise<SQSBatchResponse> {
  return async (event: DlqEvent) => {
    const parseFailures: SQSBatchResponse['batchItemFailures'] = [];

    for (const record of event.Records) {
      let parsed: JobMessage;
      try {
        parsed = JobMessageSchema.parse(JSON.parse(record.body));
      } catch {
        // Malformed body — cannot process. Return as batch failure so the
        // DLQ retains the record for manual inspection.
        deps.logger.error('[dlq-processor] failed to parse DLQ record body', {
          messageId: record.messageId,
          bodyExcerpt: record.body.slice(0, 200),
        });
        parseFailures.push({ itemIdentifier: record.messageId });
        continue;
      }

      // Process the parsed message. All side-effects are fail-open: one
      // failing record does not prevent other records from being processed.
      await processDlqMessage(parsed, deps);
    }

    return { batchItemFailures: parseFailures };
  };
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

async function processDlqMessage(msg: JobMessage, deps: DlqProcessorDeps): Promise<void> {
  const { notifier, vcs, logger, now } = deps;
  const repo = `${msg.prRef.owner}/${msg.prRef.repo}`;
  const prNumber = msg.prRef.number;
  const timestamp = (now ?? (() => new Date()))().toISOString();

  logger.info('[dlq-processor] processing DLQ message', {
    jobId: msg.jobId,
    repo,
    prNumber,
    triggeredBy: msg.triggeredBy,
    enqueuedAt: msg.enqueuedAt,
  });

  // 1. Write the failed state comment (fail-open).
  await writeFailedStateComment(vcs, msg, timestamp, logger);

  // 2. Dispatch the job.failed notification (fail-open).
  await notifier
    .dispatch({
      type: 'job.failed',
      repo,
      installationId: msg.installationId,
      jobId: msg.jobId,
      timestamp,
      prNumber,
      summary: `Job failed after all retries exhausted (DLQ). enqueuedAt=${msg.enqueuedAt}`,
    })
    .catch((notifyErr: unknown) => {
      const errMsg = notifyErr instanceof Error ? notifyErr.message : String(notifyErr);
      logger.warn('[dlq-processor] job.failed notification failed (fail-open)', {
        jobId: msg.jobId,
        error: errMsg,
      });
    });
}

/**
 * Write a "⚠️ Review failed" marker into the PR's state comment.
 *
 * `ReviewState` has no `status` field. We embed the failure signal in the
 * `modelUsed` field with a `FAILED:` prefix — the same strategy used by the
 * worker-level permanent-failure handler. Operators can grep for `FAILED:` in
 * state comments to find stuck PRs. The marker is human-readable in the PR
 * timeline (GitHub surfaces the hidden comment to bot admins).
 */
async function writeFailedStateComment(
  vcs: VCS,
  msg: JobMessage,
  timestamp: string,
  logger: DlqProcessorLogger,
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
      reviewedAt: timestamp,
      modelUsed: 'unknown',
      totalTokens: 0,
      totalCostUsd: 0,
      commentFingerprints: [],
    };

    // Embed "FAILED (DLQ): ..." in modelUsed so the failure is visible in the
    // state comment without changing the ReviewState schema.
    await vcs.upsertStateComment(ref, {
      ...failedState,
      reviewedAt: timestamp,
      modelUsed: `FAILED (DLQ): all retries exhausted — ${msg.enqueuedAt}`,
    });
  } catch (stateErr: unknown) {
    const errMsg = stateErr instanceof Error ? stateErr.message : String(stateErr);
    logger.warn('[dlq-processor] could not write failed state comment (fail-open)', {
      jobId: msg.jobId,
      repo: `${msg.prRef.owner}/${msg.prRef.repo}`,
      error: errMsg,
    });
  }
}
