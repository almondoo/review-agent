import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import type { VCS } from '@review-agent/core';
import {
  type DequeueOpts,
  type JobMessage,
  JobMessageSchema,
  type QueueClient,
} from '@review-agent/core';
import type { NotificationDispatcher } from '../notification/index.js';
import { classifyError } from './error-classifier.js';

export type SqsQueueOpts = {
  readonly queueUrl: string;
  readonly client?: SQSClient;
  readonly region?: string;
  /**
   * Optional dependencies for permanent-failure termination (#138).
   * When provided, permanent errors trigger:
   *  1. `job.failed` notification dispatch (fail-open).
   *  2. A "Review failed" marker written to the PR state comment.
   *  3. Structured log via `logger`.
   * When absent, permanent errors are logged and the message is left
   * to visibility-timeout re-delivery (same as transient behaviour).
   */
  readonly failureDeps?: SqsFailureDeps;
};

export type SqsFailureDeps = {
  readonly notifier: NotificationDispatcher;
  readonly vcs: VCS;
  readonly logger: SqsLogger;
};

export type SqsLogger = {
  error(message: string, ctx?: Record<string, unknown>): void;
  warn(message: string, ctx?: Record<string, unknown>): void;
};

export function createSqsQueueClient(opts: SqsQueueOpts): QueueClient {
  const client = opts.client ?? new SQSClient(opts.region ? { region: opts.region } : {});

  async function enqueue(message: JobMessage): Promise<{ messageId: string }> {
    JobMessageSchema.parse(message);
    const out = await client.send(
      new SendMessageCommand({
        QueueUrl: opts.queueUrl,
        MessageBody: JSON.stringify(message),
        MessageAttributes: {
          installationId: { DataType: 'String', StringValue: message.installationId },
          triggeredBy: { DataType: 'String', StringValue: message.triggeredBy },
        },
      }),
    );
    return { messageId: out.MessageId ?? '' };
  }

  async function dequeue(
    handler: (m: JobMessage) => Promise<void>,
    o: DequeueOpts = {},
  ): Promise<void> {
    const waitTime = o.waitTimeSeconds ?? 20;
    const maxMessages = o.maxMessages ?? 1;
    const visibility = o.visibilityTimeoutSeconds ?? 60;
    while (!o.stopSignal?.aborted) {
      const out = await client.send(
        new ReceiveMessageCommand({
          QueueUrl: opts.queueUrl,
          WaitTimeSeconds: waitTime,
          MaxNumberOfMessages: maxMessages,
          VisibilityTimeout: visibility,
        }),
      );
      const messages = out.Messages ?? [];
      for (const m of messages) {
        if (o.stopSignal?.aborted) return;
        if (!m.Body || !m.ReceiptHandle) continue;
        const parsed = parseBody(m.Body);
        if (!parsed) {
          // Malformed body — let visibility timeout return it to the queue,
          // and after maxReceiveCount it lands in the DLQ.
          continue;
        }
        try {
          await handler(parsed);
          await client.send(
            new DeleteMessageCommand({
              QueueUrl: opts.queueUrl,
              ReceiptHandle: m.ReceiptHandle,
            }),
          );
        } catch (err) {
          await onHandlerFailure(err, parsed, m.ReceiptHandle, client, opts);
        }
      }
    }
  }

  return { enqueue, dequeue };
}

function parseBody(body: string): JobMessage | null {
  try {
    return JobMessageSchema.parse(JSON.parse(body));
  } catch {
    return null;
  }
}

/**
 * Handle a handler-level failure from the SQS long-poll dequeue loop (#138).
 *
 * ## Transient errors
 * Let SQS visibility timeout govern retry and eventual DLQ routing. We log
 * the failure and return without ack-ing the message. This is the existing
 * behaviour for all errors prior to #138.
 *
 * ## Permanent errors
 * Retrying will not help. We:
 *  1. Dispatch a `job.failed` notification (fail-open — error is swallowed).
 *  2. Write a "Review failed" marker to the PR state comment (fail-open).
 *  3. Delete the message from SQS (ack it) so it is NOT re-delivered and
 *     does NOT reach the DLQ. The user has already been notified.
 *  4. Log the decision at `error` level.
 *
 * If `failureDeps` is not wired, permanent errors are downgraded to the
 * transient path (log + leave for SQS retry). This preserves backward
 * compatibility for operators who haven't wired up the notifier yet.
 */
async function onHandlerFailure(
  err: unknown,
  msg: JobMessage,
  receiptHandle: string,
  client: SQSClient,
  opts: SqsQueueOpts,
): Promise<void> {
  const failureClass = classifyError(err);
  const errMsg = err instanceof Error ? err.message : String(err);
  const repo = `${msg.prRef.owner}/${msg.prRef.repo}`;
  const prNumber = msg.prRef.number;

  const { failureDeps } = opts;

  if (failureClass === 'transient' || failureDeps === undefined) {
    // Transient path (or no failure deps wired): leave for SQS visibility
    // timeout + DLQ. Just log. Intentionally does NOT re-throw: a re-throw
    // would leave the consumer in a tight hot-loop.
    failureDeps?.logger.warn('[sqs] transient handler failure — leaving for SQS retry/DLQ', {
      jobId: msg.jobId,
      repo,
      prNumber,
      failureClass,
      error: errMsg,
    });
    return;
  }

  // Permanent failure: terminate the job.
  const { notifier, vcs, logger } = failureDeps;

  logger.error('[sqs] permanent handler failure — terminating job', {
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
      logger.warn('[sqs] job.failed notification dispatch failed (fail-open)', {
        jobId: msg.jobId,
        error: notifyErrMsg,
      });
    });

  // 2. Write "Review failed" marker to the PR state comment (fail-open).
  await writeFailedStateComment(vcs, msg, errMsg, logger);

  // 3. Ack the message — do not re-deliver or route to DLQ.
  // The job is definitively terminated; DLQ is unnecessary.
  await client
    .send(
      new DeleteMessageCommand({
        QueueUrl: opts.queueUrl,
        ReceiptHandle: receiptHandle,
      }),
    )
    .catch((deleteErr: unknown) => {
      const deleteErrMsg = deleteErr instanceof Error ? deleteErr.message : String(deleteErr);
      logger.warn('[sqs] failed to ack permanent-failure message — may re-deliver once', {
        jobId: msg.jobId,
        error: deleteErrMsg,
      });
    });
}

/**
 * Write a "Review failed" human-readable note to the PR's state comment.
 *
 * `ReviewState` has no `status` field (#138 chose minimal schema change).
 * We obtain the current state and, if present, upsert it back with an
 * updated `reviewedAt` and `modelUsed` suffix that signals the failure in
 * human-readable form. This is visible in the hidden state comment's
 * "Last reviewed at" footer — operators monitoring PRs see the failure.
 *
 * If reading/writing the state comment fails, we log and continue (fail-open).
 */
async function writeFailedStateComment(
  vcs: VCS,
  msg: JobMessage,
  reason: string,
  logger: SqsLogger,
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

    // Embed the failure signal into the human-readable `modelUsed` field.
    // This is the least-invasive schema-compatible way to surface "failed"
    // in the hidden state comment without adding a new DB column or changing
    // the ReviewState schema. Operators can grep the raw comment for the
    // prefix "FAILED:" to detect stuck PRs.
    const shortReason = reason.slice(0, 120);
    await vcs.upsertStateComment(ref, {
      ...failedState,
      reviewedAt: new Date().toISOString(),
      modelUsed: `FAILED: ${shortReason}`,
    });
  } catch (stateErr: unknown) {
    const stateErrMsg = stateErr instanceof Error ? stateErr.message : String(stateErr);
    logger.warn('[sqs] could not write failed state comment (fail-open)', {
      jobId: msg.jobId,
      repo: `${msg.prRef.owner}/${msg.prRef.repo}`,
      error: stateErrMsg,
    });
  }
}
