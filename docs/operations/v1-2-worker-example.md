# Worked-example: Server-mode worker for v1.2

End-to-end TypeScript reference for assembling a Lambda / Fargate
worker against the v1.2 stack — `runReview` with the eval recorder,
history reader, feedback writer, both cleanup electors, and the OTel
bridges. Each layer has its own architecture doc; this example is the
**connecting tissue** so a first-time operator can read one page and
know the wiring order.

The example is shaped for AWS Lambda + SQS but the same code runs
under Fargate / a long-lived process — just replace
`createSqsLambdaHandler` with `startWorker` and keep the rest.

## Module map

```
@review-agent/server   — receive (webhook), worker bootstrap, OTel bridges
@review-agent/runner   — runReview, agent loop, createFeedbackWriter
@review-agent/db       — createDbClient, withTenant, recorders/writers
@review-agent/runner   — fingerprint resolver (#95 / #96)
@review-agent/platform-github / @review-agent/platform-codecommit — adapters
```

## Environment

```
DATABASE_URL                 postgres URL (tenant connection — use the appRole)
DATABASE_MIGRATIONS_URL      optional, only for migrations (RLS-bypass role)
REVIEW_AGENT_BOT_LOGIN       e.g. 'review-agent[bot]' — used by feedback backfill
REVIEW_AGENT_FEEDBACK_ALLOWLIST   CSV of CodeCommit IAM principals (#95)
GITHUB_APP_ID                GitHub App credentials for installation tokens
GITHUB_APP_PRIVATE_KEY       (PEM, base64-encoded if going through SSM)
ANTHROPIC_API_KEY            primary provider; rotate via spec §15.
OTEL_EXPORTER_OTLP_ENDPOINT  OTLP collector for spans + metrics
SQS_QUEUE_URL                review job queue
SNS_TOPIC_ARNS_ALLOWLIST     CSV — CodeCommit notification topics
```

## Boot sequence

The worker has three responsibilities:

1. **Process review jobs** (`dequeue` → `runReview` → adapter `postReview`).
2. **Process feedback commands** (`dequeue` of a `kind: 'feedback'` job
   → `createFeedbackWriter.record`). The receiver classifies and
   enqueues; the worker performs the DB write under RLS.
3. **Periodic prune** (`startIdempotencyCleanup` + `startReviewHistoryCleanup`).

Run all three from one process so the advisory-lock leader election
works across the fleet automatically.

```ts
// worker/main.ts
import { Anthropic } from '@anthropic-ai/sdk';
import {
  bridgeEvalRecordErrorsToMetrics,
  bridgeFeedbackRateLimitToMetrics,
  bridgeHistoryReaderErrorsToMetrics,
  bridgePrunedRowsToMetrics,
  createSqsLambdaHandler,
  startReviewHistoryCleanup,
  startTelemetry,
} from '@review-agent/server';
import {
  createDbClient,
  createReviewEvalEventRecorder,
  createReviewHistoryWriter,
  loadRecentReviewHistory,
  withTenant,
} from '@review-agent/db';
import { createFeedbackWriter, runReview } from '@review-agent/runner';
import { createGithubVCS } from '@review-agent/platform-github';
import { createAnthropicLlmProvider } from '@review-agent/llm';

// One-time setup at module load. Lambda freezes the container between
// invocations so this runs once per cold-start and is cached.
const telemetry = startTelemetry({ exporter: 'otlp' });
const db = createDbClient({ url: process.env.DATABASE_URL ?? '' });
const evalRecorder = createReviewEvalEventRecorder(db);
const reviewHistoryWriter = createReviewHistoryWriter(db);

// Background cleanup electors. Survive Lambda freeze/thaw because the
// elector is itself stateless — each tick re-acquires the advisory
// lock. On Fargate this runs continuously.
startReviewHistoryCleanup({
  db,
  onPruned: bridgePrunedRowsToMetrics(),
});
// startIdempotencyCleanup is bootstrapped inside startWorker for
// long-lived processes, or you can call it directly for Lambda.

export const handler = createSqsLambdaHandler({
  queueUrl: process.env.SQS_QUEUE_URL ?? '',
  jobHandler: async (job) => {
    // Per-job tenant scope. Every DB read / write inside withTenant
    // sees `app.current_tenant = installationId`, which the RLS
    // policies on cost_ledger / review_history / review_eval_event
    // require.
    await withTenant(db, job.installationId, async () => {
      if (job.kind === 'review') {
        await handleReview(job);
        return;
      }
      if (job.kind === 'feedback') {
        await handleFeedback(job);
        return;
      }
      throw new Error(`unknown job kind: ${String(job satisfies never)}`);
    });
  },
  stopSignal: telemetry.stopSignal,
});

async function handleReview(job: ReviewJob): Promise<void> {
  const vcs = createGithubVCS({
    appAuth: githubAppAuth(job.installationId),
  });
  const provider = createAnthropicLlmProvider({
    apiKey: process.env.ANTHROPIC_API_KEY ?? '',
    model: 'claude-sonnet-4-6',
  });

  const pr = await vcs.getPR(job.prRef);
  const diff = await vcs.getDiff(job.prRef);

  // Phase 4 history reader. The runner calls this once per review and
  // splits the rows into <learned_facts> + rejectedFingerprints for
  // the dedup middleware.
  const historyReader = async (q: {
    installationId: bigint;
    repo: string;
    limit: number;
  }) => loadRecentReviewHistory(db, q);

  const result = await runReview(
    {
      jobId: job.jobId,
      prRepo: job.prRef,
      diff,
      pr,
      privacy: job.privacy,
      // ... reviews / repo / skills fields
    },
    provider,
    {
      evalRecorder,
      evalContext: {
        installationId: job.installationId,
        prNumber: job.prRef.number,
        headSha: diff.headSha,
      },
      historyReader,
      onEvalRecordError: bridgeEvalRecordErrorsToMetrics({
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
      }),
      onHistoryReaderError: bridgeHistoryReaderErrorsToMetrics(),
    },
  );

  await vcs.postReview(job.prRef, {
    summary: result.summary,
    comments: result.comments,
    state: result.state,
    event: result.event,
  });
}

async function handleFeedback(job: FeedbackJob): Promise<void> {
  // The receiver already resolved the fingerprint (via marker or
  // <fp_prefix>) and classified the FeedbackKind. The worker just
  // persists.
  const writer = createFeedbackWriter({
    writer: async (input) => {
      await reviewHistoryWriter(input);
    },
    redactPatterns: job.privacy?.redactPatterns,
    onRateLimit: bridgeFeedbackRateLimitToMetrics(),
  });

  await writer.record({
    installationId: job.installationId,
    repo: job.repo,
    kind: job.kind,
    fingerprint: job.fingerprint,
    factText: job.commentText,
  });
}
```

## Receiver side (webhook → enqueue)

The webhook handler runs at a different lifecycle (API Gateway-fronted
Lambda or Hono server). It does **no** DB writes itself — every
mutation is deferred to the worker through SQS. The receiver's only
jobs are: verify signature → classify (`review` vs `feedback`) →
enqueue.

```ts
// receiver/main.ts
import { createApp, checkGithubFeedbackAuthz } from '@review-agent/server';
import { createSqsQueueClient } from '@review-agent/server';
import { Octokit } from '@octokit/rest';

const queue = createSqsQueueClient({ url: process.env.SQS_QUEUE_URL ?? '' });

const app = createApp({
  queue,
  // GitHub permission check for /feedback commands (#95). When unset
  // the receiver fails-closed on every /feedback (good default).
  checkGithubFeedbackAuthz: async (input) => {
    const octokit = await octokitForInstallation(input.owner, input.repo);
    return checkGithubFeedbackAuthz({
      octokit,
      owner: input.owner,
      repo: input.repo,
      username: input.username,
    });
  },
  // CodeCommit /feedback allowlist (#95). Receiver reads this CSV;
  // worker does not re-check.
  codecommitFeedbackAllowlistEnv: process.env.REVIEW_AGENT_FEEDBACK_ALLOWLIST,
  allowedSnsTopicArns: (process.env.SNS_TOPIC_ARNS_ALLOWLIST ?? '').split(','),
});

export const handler = app.fetch;
```

## SQS message shapes

The same queue carries both job kinds. The worker discriminates on
`kind`. Validate at the queue boundary with the existing Zod
`JobMessageSchema` (`@review-agent/core`) — the schema's discriminated
union covers `kind: 'review' | 'feedback' | 'codecommit-mirror' …`.

## Operational checklist

- [ ] Run the v1.2 migration (`0003_review_eval_event.sql`) before
      rolling out the worker. The migration is forward-compatible —
      v1.1 code keeps working against the new schema (UPGRADING.md
      "From 1.1 → 1.2" §1).
- [ ] Confirm `DATABASE_URL` uses the `app_role` connection, not the
      migrations role — otherwise RLS does not engage and the worker
      will silently see other tenants' data.
- [ ] OTel exporter receives `review_agent_eval_record_errors_total`,
      `review_agent_feedback_rate_limit_drops_total`,
      `review_agent_review_history_pruned_total`,
      `review_agent_history_reader_errors_total`. Wire alerts per
      [`slo-playbook.md`](./slo-playbook.md).
- [ ] `startReviewHistoryCleanup` is bootstrapped on at least one
      worker (the advisory-lock leader election permits N≥2 workers
      to run safely; only one prunes per tick).
- [ ] CodeCommit tenants: set `REVIEW_AGENT_FEEDBACK_ALLOWLIST`
      explicitly. Empty / unset = every `/feedback` denied (fail-closed,
      see `docs/security/feedback-command-authz.md`).
- [ ] Anthropic ZDR + spend caps configured per `review-agent setup
      workspace` (v1.0 #50).

## Where this fits in the docs

- [`docs/architecture/review-eval-event.md`](../architecture/review-eval-event.md)
  — schema + recorder semantics (Phase 2).
- [`docs/architecture/feedback-loop.md`](../architecture/feedback-loop.md)
  — signal collection, `/feedback` command, fingerprint resolution
  (Phase 3 / #95 / #96).
- [`docs/architecture/learned-facts.md`](../architecture/learned-facts.md)
  — Phase 4 reader contract.
- [`docs/architecture/observability.md`](../architecture/observability.md)
  — OTel bridges (#106).
- [`docs/operations/slo-playbook.md`](./slo-playbook.md)
  — alert thresholds.
- [`docs/operations/review-eval-event-playbook.md`](./review-eval-event-playbook.md)
  — SQL recipes for analysing the table this worker writes.

## Out of scope

- Production Terraform / IaC for the Lambda + SQS topology lives in
  [`examples/aws-lambda-terraform/`](../../examples/aws-lambda-terraform).
  This doc focuses on the **code assembly**.
- Multi-region failover semantics, CodeCommit mirror reconciliation
  (#105) — call out a follow-up issue rather than inlining here.
