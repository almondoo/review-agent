# DLQ Runbook (#138)

The dead-letter queue (DLQ) receives SQS messages that the worker failed to
process after `maxReceiveCount` attempts (default 5). For each DLQ message, the
**DLQ processor Lambda** (`${name}-dlq-processor`) automatically:

1. Writes a `FAILED (DLQ): all retries exhausted` marker to the PR state comment.
2. Dispatches a `job.failed` notification via the configured channels (Slack, email).

This runbook covers how to inspect, diagnose, and replay DLQ messages when
automatic processing is not enough.

---

## 1. Detect

The CloudWatch alarm `${name}-dlq-messages` fires when any message arrives in
the DLQ. In the console: **CloudWatch → Alarms → `review-agent-dlq-messages`**.

To query programmatically:

```bash
# Approximate count of messages sitting in the DLQ right now:
aws sqs get-queue-attributes \
  --queue-url "$(terraform -chdir=examples/aws-lambda-terraform output -raw dlq_arn | \
    sed 's|arn:aws:sqs:[^:]*:[^:]*:|https://sqs.us-east-1.amazonaws.com/|')" \
  --attribute-names ApproximateNumberOfMessages

# DLQ processor Lambda logs (last 30 minutes):
aws logs tail /aws/lambda/review-agent-dlq-processor --since 30m --format short
```

---

## 2. Inspect

Peek at a DLQ message without deleting it (`--visibility-timeout 30` gives you
30 seconds to read before it becomes visible to other consumers again):

```bash
DLQ_URL=$(aws sqs get-queue-url \
  --queue-name review-agent-jobs-dlq \
  --query QueueUrl --output text)

aws sqs receive-message \
  --queue-url "$DLQ_URL" \
  --max-number-of-messages 1 \
  --visibility-timeout 30 \
  --message-attribute-names All \
  --query 'Messages[0]' | jq .
```

Key fields to examine:

| Field | What to look for |
|---|---|
| `Body.jobId` | The job identifier; correlate with `review_history` or Lambda logs. |
| `Body.prRef` | `owner/repo#number` — open the PR on GitHub to see its state. |
| `Body.enqueuedAt` | When the job was first queued; age tells you how long it was retried. |
| `Attributes.ApproximateReceiveCount` | Should equal `maxReceiveCount` (5 by default). |
| `Attributes.SentTimestamp` | Epoch ms — the first delivery time. |

Worker logs for the failed job:

```bash
# Filter by jobId (replace J-ID with the actual jobId from the DLQ message):
aws logs filter-log-events \
  --log-group-name /aws/lambda/review-agent-worker \
  --filter-pattern '"J-ID"' \
  --start-time $(date -d '7 days ago' +%s000) | \
  jq '.events[].message | fromjson? // .'
```

---

## 3. Diagnose

Common root causes and fixes:

| Symptom | Root cause | Fix |
|---|---|---|
| `CostExceededError` in logs | `cost.max_usd_per_pr` too low for a large PR | Raise the cap in `.review-agent.yml` or split the PR. |
| `ConfigError` | Malformed `.review-agent.yml` in the repo | Fix the YAML file; the job will be re-queued on the next PR event. |
| `rate_limit` repeated beyond LLM retry window | Provider rate-limit sustained | Wait for quota reset; replay the message once quota is restored. |
| `auth` from LLM provider | Invalid or expired API key | Rotate the key in Secrets Manager, force a Lambda cold start. |
| `context_length` | PR diff exceeds model context | Enable `split_diff` in config or reduce `max_diff_lines`. |
| DB connection timeout | RDS unreachable from Lambda VPC | Check security-group ingress on RDS; verify Lambda subnet routing. |

---

## 4. Replay (re-queue to main queue)

After fixing the root cause, you can send the message back to the main queue
for another processing attempt.

### 4.1 Single message replay

```bash
MAIN_URL=$(aws sqs get-queue-url \
  --queue-name review-agent-jobs \
  --query QueueUrl --output text)

# 1. Receive the message from the DLQ (capture the ReceiptHandle):
MSG=$(aws sqs receive-message \
  --queue-url "$DLQ_URL" \
  --max-number-of-messages 1 \
  --visibility-timeout 60 \
  --query 'Messages[0]')

BODY=$(echo "$MSG" | jq -r '.Body')
RECEIPT=$(echo "$MSG" | jq -r '.ReceiptHandle')

# 2. Send it back to the main queue:
aws sqs send-message \
  --queue-url "$MAIN_URL" \
  --message-body "$BODY"

# 3. Delete from DLQ (prevents re-processing by the DLQ processor):
aws sqs delete-message \
  --queue-url "$DLQ_URL" \
  --receipt-handle "$RECEIPT"
```

### 4.2 Batch replay (all DLQ messages)

Use the AWS console **SQS → Dead-letter queues → Start DLQ redrive** for a
point-and-click batch replay. This is the recommended approach for large
backlogs — the console handles batching and deletion automatically.

Alternatively, use the CLI start-message-move-task API (requires a redrive
policy with `allowedSourceQueues` on the main queue — the Terraform module
does not configure this by default):

```bash
aws sqs start-message-move-task \
  --source-arn "$(aws sqs get-queue-attributes \
    --queue-url "$DLQ_URL" \
    --attribute-names QueueArn \
    --query Attributes.QueueArn --output text)" \
  --destination-arn "$(aws sqs get-queue-attributes \
    --queue-url "$MAIN_URL" \
    --attribute-names QueueArn \
    --query Attributes.QueueArn --output text)"
```

### 4.3 Discard without replay

If the job should be abandoned (e.g. the PR was closed, or the failure is
permanent and there is nothing to fix):

```bash
aws sqs delete-message \
  --queue-url "$DLQ_URL" \
  --receipt-handle "$RECEIPT"
```

---

## 5. Verify recovery

After replay, check that the worker processed the job:

```bash
# Worker logs for the replayed jobId:
aws logs tail /aws/lambda/review-agent-worker --since 10m --format short | \
  grep J-ID

# GitHub PR: the bot comment should appear (or be updated) within ~1 minute.
```

---

## 6. Scope note — GCP Pub/Sub and Azure Service Bus

DLQ-equivalent consumption on **GCP Pub/Sub** (dead-letter topics) and
**Azure Service Bus** (dead-letter subqueues) is architecturally different from
SQS (push-vs-pull, differing ack semantics) and is tracked as a follow-up issue
to be filed separately. Until those adapters land, use the respective platform's
console tooling for DLQ inspection and replay.
