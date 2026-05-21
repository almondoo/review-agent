# `review_eval_event` SQL playbook

This is the ops-side companion to
[`docs/architecture/review-eval-event.md`](../architecture/review-eval-event.md).
The architecture doc explains the table and how the runner writes it; this
playbook gives the **canonical queries** for reading it — what to ask after
a prompt change, after a provider swap, or during a monthly review retro.

## Scope and connection setup

All queries below are written **for the `appRole` connection** with the
tenant pre-set via `withTenant(installationId, ...)` (`@review-agent/db`).
From a `psql` shell:

```sql
SET LOCAL ROLE app_role;
SET LOCAL app.current_tenant = '12345';  -- installation_id
```

Run them under the `migrations` / superuser role only when you genuinely
need cross-tenant aggregates — flagged per query below. The RLS policy
on `review_eval_event` is `installation_id::text =
current_setting('app.current_tenant', true)`; under `appRole` a missing
or mismatched setting silently returns zero rows (no error). Verify
expected row counts before drawing conclusions.

> The same applies to JOINs against `cost_ledger`: that table has the
> same RLS policy, so both legs of a join either resolve under the same
> tenant or both return empty.

Index reminders (see `0003_review_eval_event.sql`):

- `review_eval_event_installation_repo_idx (installation_id, repo)`
- `review_eval_event_created_at_idx (created_at)`
- `review_eval_event_job_idx (installation_id, job_id)`

The (`installation_id`, `repo`) index is the workhorse — most queries
below filter on those two columns first.

## Recipes

### 1. Per-provider average latency / cost / comment count (last 30 days)

Use after a model swap to verify the new provider is not silently
worse on cost or latency.

```sql
SELECT
  provider,
  model,
  count(*)                   AS reviews,
  round(avg(latency_ms)::numeric, 0)  AS avg_latency_ms,
  round(avg(cost_usd)::numeric, 4)    AS avg_cost_usd,
  round(avg(comment_count)::numeric, 1) AS avg_comments,
  percentile_cont(0.5)  WITHIN GROUP (ORDER BY latency_ms) AS p50_latency_ms,
  percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) AS p95_latency_ms
FROM review_eval_event
WHERE created_at >= now() - interval '30 days'
GROUP BY provider, model
ORDER BY reviews DESC;
```

- Uses `review_eval_event_created_at_idx` for the date filter.
- `p95_latency_ms` matches the `Review latency` SLO in
  [`slo-playbook.md`](./slo-playbook.md); the alert threshold is `> 90s`.

### 2. Severity distribution shift, week over week

Use this to detect prompt regressions where the rubric stops producing
critical findings (or starts producing too many).

```sql
SELECT
  date_trunc('week', created_at) AS week,
  sum((severity_dist->>'critical')::int) AS critical,
  sum((severity_dist->>'major')::int)    AS major,
  sum((severity_dist->>'minor')::int)    AS minor,
  sum((severity_dist->>'info')::int)     AS info,
  count(*) AS reviews
FROM review_eval_event
WHERE created_at >= now() - interval '12 weeks'
GROUP BY week
ORDER BY week;
```

- `severity_dist` is JSONB; coerce to int via `->>` then cast.
- Look for sudden shifts in either direction after a `BASE_SYSTEM_PROMPT`
  edit. A week with 0 `critical` after months of nonzero is the
  prompt-regression smell test.

### 3. `dropped_by_feedback` top-N repos (last 14 days)

Where the v1.2 epic #83 Phase 4 (#93) feedback loop is most active —
high counts mean the bot is being told "stop saying this" frequently
on that repo, which is either (a) successful learning, or (b) a noisy
rule the operator should sharpen.

```sql
SELECT
  repo,
  sum(dropped_by_feedback) AS dropped_total,
  count(*) AS reviews,
  round(avg(dropped_by_feedback)::numeric, 2) AS avg_dropped_per_review
FROM review_eval_event
WHERE created_at >= now() - interval '14 days'
  AND dropped_by_feedback > 0
GROUP BY repo
ORDER BY dropped_total DESC
LIMIT 10;
```

- The `WHERE dropped_by_feedback > 0` filter lets the planner skip the
  zero-rows that dominate the table when Phase 4 is still ramping up.

### 4. Dedup effectiveness — `dropped_duplicates` ratio

Incremental review (#19) and fingerprint dedup (#9) should suppress
re-flags of the same finding across multiple `synchronize` events. A
falling ratio after a prompt change can mean the LLM is now emitting
phrasings that bypass the same-line dedup.

```sql
SELECT
  date_trunc('day', created_at) AS day,
  sum(comment_count)        AS posted,
  sum(dropped_duplicates)   AS deduped,
  round(
    sum(dropped_duplicates)::numeric
      / nullif(sum(comment_count) + sum(dropped_duplicates), 0),
    3
  ) AS dedup_ratio
FROM review_eval_event
WHERE created_at >= now() - interval '14 days'
GROUP BY day
ORDER BY day;
```

- `nullif(... , 0)` avoids `division by zero` on quiet days.
- Plot the ratio over time; a falling line is the early signal.

### 5. `abort_reason` distribution

`abort_reason` is non-null when the agent loop gracefully aborted
(`url_allowlist`, `schema_violation`, `max_files_exceeded`,
`max_diff_lines_exceeded`). Use to size the caps in
`.review-agent.yml`.

```sql
SELECT
  coalesce(abort_reason, 'ok') AS reason,
  count(*) AS occurrences,
  round(100.0 * count(*) / sum(count(*)) OVER (), 2) AS pct_of_reviews
FROM review_eval_event
WHERE created_at >= now() - interval '30 days'
GROUP BY abort_reason
ORDER BY occurrences DESC;
```

- A spike in `max_files_exceeded` is your cue that
  `reviews.max_files` is too tight (or your repo really does have
  monster PRs).
- A spike in `schema_violation` after a prompt edit means the model is
  no longer reliably emitting the strict-JSON shape; consider
  rolling back the prompt.

### 6. Per-call vs per-review latency — JOIN to `cost_ledger`

`review_eval_event.latency_ms` is the **wall-clock** time the runner
spent inside `runReview` (gitleaks + LLM + dedup + scan). `cost_ledger`
has per-LLM-call rows with their own `latency_ms`. When the runner
makes one main call + N injection-detect calls + retries, the per-call
sum can lag per-review wall-clock by the middleware overhead. A wide
gap = something inside the runner outside the LLM calls is slow.

```sql
WITH per_review_calls AS (
  SELECT
    job_id,
    sum(latency_ms) AS sum_call_latency_ms,
    sum(cost_usd)   AS sum_call_cost_usd,
    count(*)        AS llm_calls
  FROM cost_ledger
  WHERE created_at >= now() - interval '7 days'
  GROUP BY job_id
)
SELECT
  r.job_id,
  r.repo,
  r.provider,
  r.latency_ms        AS review_latency_ms,
  c.sum_call_latency_ms,
  r.latency_ms - c.sum_call_latency_ms AS runner_overhead_ms,
  c.llm_calls
FROM review_eval_event r
JOIN per_review_calls c USING (job_id)
WHERE r.created_at >= now() - interval '7 days'
ORDER BY runner_overhead_ms DESC
LIMIT 20;
```

- Both tables are RLS-scoped on `installation_id`, so the join stays
  inside the tenant.
- Sort by `runner_overhead_ms DESC` to find the worst non-LLM
  contributors (gitleaks regressions, slow `read_file` tool calls,
  middleware bugs).

### 7. Confidence distribution — calibrating `reviews.min_confidence`

Before raising the floor (e.g. `low → medium`), check how many
findings you would actually drop.

```sql
SELECT
  sum((confidence_dist->>'high')::int)   AS high,
  sum((confidence_dist->>'medium')::int) AS medium,
  sum((confidence_dist->>'low')::int)    AS low,
  round(
    100.0 * sum((confidence_dist->>'low')::int)
          / nullif(sum((confidence_dist->>'high')::int)
                  + sum((confidence_dist->>'medium')::int)
                  + sum((confidence_dist->>'low')::int), 0),
    2
  ) AS pct_low
FROM review_eval_event
WHERE created_at >= now() - interval '30 days';
```

- If `pct_low` is small (< 5%), raising `min_confidence: medium` is
  unlikely to change reviewer experience meaningfully.
- Comments emitted without a `confidence` field are counted under
  `high` per the legacy default — the column never decreases when the
  model omits the field.

## Cross-tenant queries (run as `migrations` / superuser)

These return zero rows under `appRole` because of RLS. Use sparingly —
single-tenant queries above are the default.

### Fleet-wide median latency per provider

```sql
SET ROLE migrations_admin; -- or whichever role bypasses RLS

SELECT
  provider,
  model,
  percentile_cont(0.5)  WITHIN GROUP (ORDER BY latency_ms) AS p50,
  percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) AS p95,
  count(*) AS reviews
FROM review_eval_event
WHERE created_at >= now() - interval '7 days'
GROUP BY provider, model
ORDER BY reviews DESC;

RESET ROLE;
```

Always pair `SET ROLE` with `RESET ROLE` so a forgotten cross-tenant
connection does not leak into your next query.

## Out of scope

The architecture doc lists the deferred items (Grafana / Looker
dashboards, BI integrations, pairwise judge correlation). This playbook
sticks to single-SQL recipes that operators can paste into `psql` or a
generic SQL UI.
