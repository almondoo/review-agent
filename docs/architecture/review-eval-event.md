# `review_eval_event` — per-review evaluation metrics

Spec references: §7.6 (review_history adjacent), §16.1 (RLS), v1.2 epic [#83](https://github.com/almondoo/review-agent/issues/83) Phase 2 ([#91](https://github.com/almondoo/review-agent/issues/91)).

## What this is

A Postgres table — one row per `runReview` invocation — that records the
per-review metrics needed to detect regressions, compare provider quality,
and measure the effect of prompt changes over time. The `cost_ledger`
table records *per-LLM-call* rows (one for the main call, one for each
retry / injection-detect call). `review_eval_event` is the *per-review*
summary that aggregates them so downstream queries don't need to join.

## Columns

| Column | Type | Notes |
|---|---|---|
| `id` | `bigserial PK` | |
| `installation_id` | `bigint` | RLS key — mirrors `cost_ledger` / `review_history`. |
| `job_id` | `text` | The runner's per-review identifier. |
| `repo` | `text` | `"<owner>/<repo>"`. |
| `pr_number` | `integer` | |
| `head_sha` | `text` | The PR head at the time of the review. |
| `provider` / `model` | `text` | Driver name + model id. |
| `comment_count` | `integer` | Posted comments (post-dedup, post-confidence-filter, post-redaction). |
| `severity_dist` | `jsonb` | `{critical, major, minor, info}` counts. |
| `confidence_dist` | `jsonb` | `{high, medium, low}` counts. Comments without an explicit `confidence` count under `high` (legacy default). |
| `dropped_duplicates` | `integer` | Suppressed by the fingerprint dedup middleware. |
| `dropped_by_feedback` | `integer` | Suppressed because a prior `factType: 'rejected_finding'` row matched. Stays 0 until Phase 4 (#93) lands. |
| `tool_calls` | `integer` | Total `read_file` / `glob` / `grep` invocations across the agent loop. |
| `latency_ms` | `integer` | Wall-clock time the runner spent inside `runReview`. |
| `cost_usd` | `double precision` | Total cost, matching `RunnerResult.costUsd`. |
| `tokens_input` / `tokens_output` | `integer` | Same fields as `RunnerResult.tokensUsed`. |
| `abort_reason` | `text` (nullable) | Set to a `REVIEW_ABORT_REASONS` value when the review gracefully aborted (`url_allowlist`, `schema_violation`, `max_files_exceeded`, `max_diff_lines_exceeded`). NULL on happy path. |
| `created_at` | `timestamptz` | |

`cost_ledger` also gained a `latency_ms` column so per-call latency can
be inspected without joining back to the per-review summary.

## RLS

Tenant isolation mirrors `cost_ledger` / `review_history` — the policy
checks `installation_id::text = current_setting('app.current_tenant')`.
Wrap reads in `withTenant(installationId, ...)` (`@review-agent/db`).

## How the runner records events

```ts
import { runReview } from '@review-agent/runner';
import { createReviewEvalEventRecorder, createDbClient, withTenant } from '@review-agent/db';

const db = createDbClient({ url: process.env.DATABASE_URL });
const recorder = createReviewEvalEventRecorder(db);

await withTenant(installationId, async () => {
  await runReview(job, provider, {
    evalRecorder: recorder,
    evalContext: { installationId, prNumber, headSha },
    onEvalRecordError: (err) => log.warn({ err }, 'review_eval_event insert failed'),
  });
});
```

Both `evalRecorder` and `evalContext` are optional. When either is
absent the runner skips event recording with zero overhead — useful
for local CLI runs and eval-harness tests.

## Fail-open guarantee

The recorder is invoked **after** the agent loop has built its
`RunnerResult`. Insert errors are caught inside the runner and routed
through `onEvalRecordError`. A transient DB outage never crashes a
review that has already posted its comments — the per-review row is
silently dropped, and the operator sees a log warning.

## Migrations

Schema and migration live in `@review-agent/core/db`:

- `packages/core/src/db/schema/review-eval-event.ts` — Drizzle model.
- `packages/core/src/db/migrations/0003_review_eval_event.sql` — DDL + RLS policy + `cost_ledger.latency_ms` column.

Run `pnpm --filter @review-agent/db db:migrate` to apply.

## Operator SQL playbook

For canonical SELECT queries — per-provider averages, severity shifts,
`dropped_by_feedback` ranking, dedup ratio trend, `abort_reason`
distribution, per-call/per-review latency JOIN, `confidence_dist`
calibration — see
[`docs/operations/review-eval-event-playbook.md`](../operations/review-eval-event-playbook.md).
