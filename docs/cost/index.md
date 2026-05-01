# Cost guardrails

`review-agent` charges to your LLM provider on every PR review. This
document describes how the agent enforces the per-PR + per-day cost
caps, the four threshold tiers, and how to tune them.

Spec references: §6.2, §10.1, §13.2, §16.3.

---

## How enforcement works

Two checks fire on every job:

1. **Job-start preflight** — `preflightDailyCap()` reads the current
   day's `installation_cost_daily.cost_usd` row. If it's already
   >= `cost.daily_cap_usd`, the worker rejects the job before any LLM
   call. The agent posts a "Daily cap reached" summary and exits.

2. **Per-call cost guard middleware** — for each `generateReview` call
   the cost-guard middleware estimates input tokens, projects total
   cost, and consults the four-tier decision engine.

The decision engine (`decideCostAction` in `@review-agent/core`)
returns one of:

| Decision | Trigger | Behaviour |
|---|---|---|
| `proceed` | projected ≤ 80% of cap | Run the call. |
| `fallback` | 80% < projected ≤ 100% | Run the call, but signal the runner to switch to the cheaper fallback model on the next call. |
| `abort` | projected > 100%, or daily cap reached | Throw `CostExceededError`. The worker emits a `cost_exceeded` ledger row + audit entry. |
| `kill` | running > 150% of cap | Throw `CostExceededError` AND fire a SIGTERM at the worker process. SQS visibility timeout will redeliver to a fresh worker — but the cap-exceeded record on the ledger blocks it from re-running until the next day. |

The 150% kill threshold is intentional paranoia. Cost estimation can
drift up to ±20% (different tokenisers, cache hits, retry costs). A
running cumulative more than 1.5× the cap means estimation drift
alone cannot explain the overrun, so the safest move is to drop the
worker entirely and let the operator investigate.

## Configuration

Per-repo `.review-agent.yml`:

```yaml
cost:
  max_usd_per_pr: 1.00     # per-PR cap, hard
  hard_stop: true          # if true, abort instead of best-effort partial review
  daily_cap_usd: 50.00     # per-installation daily ceiling
```

Defaults live in `@review-agent/config`'s schema. The agent reads
these once per job — config changes in the repo take effect on the
next webhook event.

The CLI / Action / server can override `daily_cap_usd` via env:

```bash
REVIEW_AGENT_MAX_USD_PER_PR=0.50 review-agent review --pr 42 --repo o/r
```

A v0.4 follow-up adds **per-installation daily cap overrides** (DB
row, settable from a future admin API). For v0.3 the daily cap is
effectively per-repo via the same `cost.daily_cap_usd` value.

## Wiring in a worker

```ts
import {
  assertDailyCapNotExceeded,
  createCostGuard,
  createCostKillSwitch,
} from '@review-agent/runner';
import { createCostTotalsReader, createCostLedgerRecorder } from '@review-agent/db';
import { withSpan } from '@review-agent/server';

export async function processJob(job: Job, deps: Deps) {
  const readTotals = createCostTotalsReader(deps.db);
  const recorder = createCostLedgerRecorder(deps.db);

  // 1. Job-start preflight — burns ~5ms but saves an LLM call when capped.
  await assertDailyCapNotExceeded(
    {
      installationId: job.installationId,
      jobId: job.jobId,
      dailyCapUsd: job.config.cost.daily_cap_usd,
    },
    { readTotals },
  );

  // 2. Build the per-call middleware with all the threshold hooks wired up.
  const killSwitch = createCostKillSwitch();
  const costGuard = createCostGuard({
    state: { totalCostUsd: 0 },
    dailyCapUsd: job.config.cost.daily_cap_usd,
    readTotals: () =>
      readTotals({
        installationId: job.installationId,
        jobId: job.jobId,
        date: todayUtc(),
      }),
    recorder,
    recordContext: {
      installationId: job.installationId,
      jobId: job.jobId,
      provider: job.config.provider?.type ?? 'anthropic',
      model: job.config.provider?.model ?? 'claude-sonnet-4-6',
    },
    onThresholdCrossed: (event) => {
      withSpan('llm.call', { ...spanCtx, ...costAttrs(event) }, async () => undefined);
      killSwitch(event); // SIGTERM only on the kill threshold
      if (event.threshold !== 'fallback') {
        deps.audit.append({
          installationId: job.installationId,
          prId: job.jobId,
          event: 'cost_cap_exceeded',
          model: job.config.provider?.model ?? 'claude-sonnet-4-6',
        });
      }
    },
  });

  // ... compose middleware, run runReview, etc.
}

function costAttrs(e: { threshold: string; cumulativeUsd: number; capUsd: number }) {
  return {
    'cost.threshold_crossed': e.threshold,
    'cost.cumulative_usd': e.cumulativeUsd,
    'cost.cap_usd': e.capUsd,
  };
}
```

## Telemetry

Three OTel attributes fire on every threshold transition:

| Attribute | Type | Meaning |
|---|---|---|
| `cost.threshold_crossed` | string | One of `fallback` / `abort` / `kill` / `daily_cap`. |
| `cost.cumulative_usd` | number | The running total (USD) that triggered the transition. |
| `cost.cap_usd` | number | The configured cap (per-PR or daily) being compared against. |

These pair with the `review_agent_cost_usd_total` counter
(`@review-agent/server` `getMetrics`) for dashboard alerts:

```promql
# 5-minute spike in cap breaches
sum(rate(review_agent_cost_usd_total{status="cost_exceeded"}[5m])) by (installation)
```

## Audit trail

Every cap breach writes one `audit_log` row with `event =
'cost_cap_exceeded'` (HMAC-chained per §13.3). Verify the chain
periodically:

```ts
import { verifyAuditChainFromDb } from '@review-agent/db';
const report = await verifyAuditChainFromDb(db);
if (!report.valid) alertOncall(report);
```

## Operational checklist

- [ ] `cost.max_usd_per_pr` set to a number you'd be comfortable
      paying once for a single PR. Default is $1.00.
- [ ] `cost.daily_cap_usd` set to the per-installation budget (one
      installation = one GitHub App installation, typically one org).
      Default is $50.00.
- [ ] CloudWatch / Grafana alert wired on
      `cost.threshold_crossed{threshold="kill"}` — kill-switch fires
      should never be silent.
- [ ] Daily report emitted from `installation_cost_daily` so finance
      sees the trend, not just the breaches.
- [ ] Audit chain verified on a schedule (cronjob calling
      `verifyAuditChainFromDb`).
- [ ] Provider-side spend cap also configured (Anthropic Workspace
      daily limit, OpenAI hard cap) — defence in depth, in case the
      ledger gets out of sync with reality.

## Tuning advice

- **Bumping `max_usd_per_pr` for large monorepos**: rather than
  raising the global default, set a higher cap on the specific repo
  via its `.review-agent.yml`. Other repos in the org keep the
  conservative default.
- **Cheaper fallback model**: configure `provider.fallback_models` so
  the 80% threshold actually saves money rather than just signalling.
- **Daily cap math**: `(typical PRs/day) × (avg cost/PR) × 2` is a
  reasonable starting point. The 2× headroom absorbs a busy day
  without false-positive cap-hits.
- **Kill-switch noise**: if you see `kill` events without a clear
  cause, audit the cost ledger for the offending PR. Common causes:
  a tool loop, a repo with unusually large diffs, or a model price
  change AWS / OpenAI didn't announce loudly.

## Recovery from a cap breach

1. Identify the PR + installation from the audit row.
2. Inspect `cost_ledger` to see which call(s) overran:
   ```sql
   SELECT call_phase, model, cost_usd, status
   FROM cost_ledger
   WHERE installation_id = $1 AND job_id = $2
   ORDER BY created_at;
   ```
3. If the breach was estimation drift on a legitimate PR: bump the
   per-PR cap on that repo's `.review-agent.yml` and re-trigger via
   `@review-agent rerun` (PR comment command).
4. If the breach looks like a tool loop: pin the failed call's model
   to a smaller variant in the repo config until the next release
   ships the loop fix.
