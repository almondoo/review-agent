# @review-agent/server

Hono-based webhook receiver. Verifies the GitHub `X-Hub-Signature-256`,
deduplicates by `X-GitHub-Delivery`, routes events, and enqueues a review
job to the configured `QueueClient`. Returns 2xx within the 10s GitHub
delivery deadline regardless of downstream work.

## Routes

| Method | Path | Notes |
|---|---|---|
| `GET` | `/healthz` | Liveness; returns `{ ok: true }`. |
| `POST` | `/webhook` | GitHub webhook receiver. Requires `x-hub-signature-256` and `x-github-delivery` headers. |

## Event routing

| `X-GitHub-Event` | Action | Behavior |
|---|---|---|
| `pull_request` | `opened` / `synchronize` / `reopened` / `ready_for_review` | Enqueue `pull_request.<action>` job. Drafts are skipped. |
| `pull_request_review`, `pull_request_review_comment`, `issue_comment` (on PRs) | `@review-agent <command>` body | `review` enqueues; other commands return `{ kind: 'noop' }` until v0.2 #16 worker dispatch lands. |
| `installation`, `installation_repositories` | any | Receiver-side ack only (handled by worker in v0.2 #16 / #19). |
| `ping` | — | `{ kind: 'noop' }`. |

## Deployment adapters

```ts
// AWS Lambda + API Gateway / Function URL
import { createLambdaHandler } from '@review-agent/server/serverless';
export const handler = createLambdaHandler({ db, queue, webhookSecret });

// Node.js (Fargate, k8s, docker-compose)
import { startNodeServer } from '@review-agent/server/node';
startNodeServer({ db, queue, webhookSecret, port: 8080 });
```

`db` is a `@review-agent/db` `DbClient`, `queue` is any `QueueClient`
(`createSqsQueueClient` for AWS, future Pub/Sub / Service Bus adapters
plug in via the same interface), `webhookSecret` is the GitHub App
webhook secret (Appendix B `GITHUB_WEBHOOK_SECRET`).

## Worker

The worker process consumes the queue, applies the synchronize debounce,
and runs the review handler.

```ts
import { createSqsQueueClient, startWorker } from '@review-agent/server';

const queue = createSqsQueueClient({ queueUrl: process.env.QUEUE_URL });
await startWorker({
  db,
  queue,
  handler: async (msg) => {
    // run the runner / post comments
  },
});
```

Lambda SQS-trigger:

```ts
import { createSqsLambdaHandler } from '@review-agent/server';
export const worker = createSqsLambdaHandler({ handler });
```

`createSqsLambdaHandler` returns a partial-batch-failure handler:
records that fail validation or whose handler throws are reported back
via `batchItemFailures` so SQS only redrives the failed messages
(`maxReceiveCount: 5`, then DLQ).

### Synchronize debounce (§11.2)

`startWorker` checks the latest `review_state` row for the PR. If a
synchronize message arrives whose `headSha` differs from the latest
stored head and the latest state was updated within the debounce window
(default 5s), the message is dropped — a fresher push is already
in flight.

### Idempotency cleanup (§7.2)

`startIdempotencyCleanup` runs an hourly sweep that deletes
`webhook_deliveries` rows older than 7 days. Election uses
`pg_try_advisory_lock(0xabba0001)` so a multi-worker fleet only deletes
once per cycle. Use `pg_cron` instead in environments that support it.

## Security

- Signature verification reads the **raw body** before JSON parse and uses
  `crypto.timingSafeEqual` (spec §7.1 verbatim).
- Missing and invalid signature share the identical 401 response so the
  caller can't distinguish failure modes.
- Idempotency is enforced via the `webhook_deliveries` table with
  `INSERT ... ON CONFLICT DO NOTHING` — duplicate deliveries return
  `{ deduped: true }` with 200.
- The receiver only enqueues. Comment posting, cloning, and LLM calls
  happen in the worker (v0.2 #16) so the 10s webhook deadline is never
  the long pole.

## License

Apache-2.0
