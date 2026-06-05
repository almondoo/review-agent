# Notifications (#144)

This page covers configuration and operation of the notification system introduced in issue #144.

## Events

Three event types are dispatched:

| Event | When |
|---|---|
| `review.completed` | `runReview` returns successfully (a review was run and posted). |
| `budget.overrun` | Cumulative cost for a job crosses `cost.budget_alert_usd`. Informational — the review continues. |
| `job.failed` | `runReview` throws a permanent error (cost cap exceeded, secret leak abort, etc.). **Interim** — see [DLQ-based detection](#job-failed-interim-note) below. |

## Configuration

Add a `notifications:` block to `.review-agent.yml`:

```yaml
notifications:
  events:
    review_completed: true    # dispatch review.completed on success (default: false)
    budget_overrun: true      # dispatch budget.overrun on soft alert (default: false)
    job_failed: true          # dispatch job.failed on permanent failure (default: false)
  slack:
    enabled: true             # requires REVIEW_AGENT_SLACK_WEBHOOK_URL env
  email:
    enabled: true
    transport: smtp           # smtp or ses
    from: "Review Agent <noreply@example.com>"
    to:
      - ops@example.com
    smtp:
      host: smtp.example.com
      port: 587
      secure: false
      user: noreply@example.com
      # Password from env REVIEW_AGENT_SMTP_PASSWORD
```

For SES transport:

```yaml
email:
  enabled: true
  transport: ses
  from: "Review Agent <noreply@example.com>"
  to:
    - ops@example.com
  ses:
    region: us-east-1   # optional; falls back to AWS_REGION credential chain
```

### Budget alert threshold

To enable `budget.overrun` notifications, also set the soft alert threshold:

```yaml
cost:
  budget_alert_usd: 0.50   # fires when cumulative cost per job exceeds this value
notifications:
  events:
    budget_overrun: true
  slack:
    enabled: true
```

## Environment variables

| Variable | Channel | Description |
|---|---|---|
| `REVIEW_AGENT_SLACK_WEBHOOK_URL` | Slack | Incoming webhook URL. Required when `notifications.slack.enabled: true`. |
| `REVIEW_AGENT_SMTP_PASSWORD` | SMTP email | SMTP account password. Required when transport is `smtp`. |

AWS credentials for SES are sourced from the credential chain (environment variables, IAM role, instance profile). No dedicated env key is needed.

## Channels

### Slack

Posts to a Slack incoming webhook. Uses Node's built-in `fetch` — no extra dependencies. The message includes event type, repo, PR number, job ID, summary, and timestamp.

### SMTP email

Uses `nodemailer`. Subject and body contain event type, repo, PR number, and summary metadata only — no code, diffs, or PII.

### Amazon SES

Uses `@aws-sdk/client-ses`. AWS credentials must be available to the process (IAM role, instance profile, or environment). Subject and body have the same shape as SMTP.

## Fail-open guarantee

A channel failure (network error, credential issue, channel misconfiguration) is logged and skipped. Other channels still receive the event. Notification failure never aborts the review or prevents the result from being posted.

## `job.failed` detection

`job.failed` is dispatched through two complementary paths:

### 1. Inline permanent-failure detection (worker path)

When the worker handler throws an error classified as **permanent** (cost cap
exceeded, auth failure, context length, config/schema error, secret-leak abort,
gitleaks scan failure), the worker:

1. Classifies the error via `classifyError` from `packages/server/src/queue/error-classifier.ts`.
2. Dispatches `job.failed` immediately (before any SQS retry).
3. Writes a `FAILED: <reason>` marker to the PR state comment.
4. Acks the SQS message so it is NOT re-delivered and does NOT reach the DLQ.

**Transient errors** (LLM rate-limit, overloaded, transient network failures) are left for SQS visibility-timeout retry. After `maxReceiveCount` retries the message lands in the DLQ.

### 2. DLQ processor (exhausted-retry path)

When a message lands in the SQS dead-letter queue (all retries exhausted), the
**DLQ processor Lambda** (`${name}-dlq-processor`) fires automatically and:

1. Parses the DLQ message body as a `JobMessage`.
2. Writes a `FAILED (DLQ): all retries exhausted` marker to the PR state comment.
3. Dispatches `job.failed` with `summary` indicating the DLQ path.

This path catches transient failures that persisted through all retries. See
[`docs/operations/dlq-runbook.md`](./dlq-runbook.md) for inspection and replay
procedures.

### GCP Pub/Sub and Azure Service Bus

DLQ-equivalent consumption on GCP Pub/Sub (dead-letter topics) and Azure
Service Bus (dead-letter subqueues) is tracked as a follow-up issue. Until
those adapters land, use the respective platform's console tooling for DLQ
inspection and replay, and configure CloudWatch-equivalent alerts manually.

## Server / operator `JobHandler` wiring

The Hono webhook server enqueues jobs to SQS but does NOT call `runReview` in-process. Notification wiring for the server path is the operator's responsibility inside their `JobHandler`:

```typescript
import {
  buildNotificationChannels,
  createNotificationDispatcher,
} from '@review-agent/server/notification';
import { runReview } from '@review-agent/runner';

const notifier = createNotificationDispatcher({
  channels: buildNotificationChannels(config.notifications, {
    REVIEW_AGENT_SLACK_WEBHOOK_URL: process.env.REVIEW_AGENT_SLACK_WEBHOOK_URL,
    REVIEW_AGENT_SMTP_PASSWORD: process.env.REVIEW_AGENT_SMTP_PASSWORD,
  }),
  config: config.notifications,
});

const handler: JobHandler = async (msg) => {
  const jobId = `${msg.prRef.owner}/${msg.prRef.repo}#${msg.prRef.number}`;
  const repo = `${msg.prRef.owner}/${msg.prRef.repo}`;

  const onThresholdCrossed = (e) => {
    if (e.threshold === 'budget_alert') {
      notifier.dispatch({
        type: 'budget.overrun',
        repo,
        installationId: String(msg.installationId),
        jobId,
        timestamp: new Date().toISOString(),
        prNumber: msg.prRef.number,
        summary: `Budget alert: $${e.cumulativeUsd.toFixed(4)} > threshold $${e.capUsd.toFixed(4)}`,
      }).catch(() => {});
    }
  };

  try {
    const result = await runReview(job, provider, {
      onThresholdCrossed,
      budgetAlertUsd: config.cost.budget_alert_usd,
    });
    // dispatch review.completed
    notifier.dispatch({
      type: 'review.completed',
      repo,
      installationId: String(msg.installationId),
      jobId,
      timestamp: new Date().toISOString(),
      prNumber: msg.prRef.number,
      summary: `Review completed: ${result.comments.length} findings`,
    }).catch(() => {});
  } catch (err) {
    // dispatch job.failed (interim — see DLQ note above)
    notifier.dispatch({
      type: 'job.failed',
      repo,
      installationId: String(msg.installationId),
      jobId,
      timestamp: new Date().toISOString(),
      prNumber: msg.prRef.number,
      summary: `Job failed: ${err instanceof Error ? err.message : String(err)}`,
    }).catch(() => {});
    throw err;
  }
};
```

## CLI

Notifications are NOT dispatched from the CLI (`review-agent review`). The CLI is a local/interactive tool; operational notifications (Slack, email) are appropriate only for server and Action deployments. If you need notification output from the CLI, implement a wrapper that calls `runReview` directly and wires the dispatcher as shown in the server example above.
