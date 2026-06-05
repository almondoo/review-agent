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

## `job.failed` — interim note

The `job.failed` event is dispatched when `runReview` throws an error at the point `runReview` is called (Action entrypoint or operator `JobHandler`). This catches cost cap exceeded, secret leak abort, schema validation abort, and similar hard failures.

**Accurate DLQ-based detection** (a message reaching the SQS dead-letter queue after all retries are exhausted) is out of scope for this wave and tracked in issue #138. Until #138 lands, transient failures that are retried and eventually succeed will not produce a `job.failed` notification, and a failure surfaced to the DLQ but not explicitly thrown by `runReview` will not be caught here. Use SQS CloudWatch alarms on `NumberOfMessagesSentToDeadLetterQueue` for production alerting on DLQ exhaustion.

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
