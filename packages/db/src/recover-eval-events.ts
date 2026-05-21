import { costLedger, reviewEvalEvent } from '@review-agent/core/db';
import { and, eq, gte, inArray, sql } from 'drizzle-orm';
import type { DbClient } from './connection.js';

/**
 * v1.2 #105 — `recover review-eval-events` source-of-truth: aggregate
 * `cost_ledger` per `(installation_id, job_id)` and back-fill any
 * matching `review_eval_event` row that is missing.
 *
 * Locked Q1 (issue body): the financial fields (`token_input` /
 * `token_output` / `cost_usd` / `latency_ms`) are reconstructible
 * via SUM. The LLM-output-dependent fields (`comment_count`,
 * `severity_dist`, `confidence_dist`, `dropped_*`, `tool_calls`,
 * `abort_reason`) are NOT recoverable from `cost_ledger` and are
 * filled with empty / zero defaults — the row exists for continuity
 * but per-review analytics on those columns must treat recovered
 * rows specially.
 *
 * cost_ledger does not carry `repo`, `pr_number`, or `head_sha`, so
 * the recovery scopes by `(installation_id, --repo)` from the CLI
 * args. The recovered row's `repo` reflects the CLI input; the
 * per-PR fields are set to empty markers (`pr_number = 0`,
 * `head_sha = ''`) so a downstream consumer can detect them.
 *
 * Idempotent: rows where `(installation_id, job_id)` already exists
 * in `review_eval_event` are left untouched and counted as
 * `skippedExisting`. Safe to re-run.
 */
export type RecoverEvalEventsOpts = {
  readonly installationId: bigint;
  readonly repo: string;
  readonly since?: Date;
  readonly dryRun?: boolean;
};

export type RecoverEvalEventsResult = {
  readonly status: 'ok';
  readonly candidates: number;
  readonly recovered: number;
  readonly skippedExisting: number;
};

export async function recoverReviewEvalEvents(
  db: DbClient,
  opts: RecoverEvalEventsOpts,
): Promise<RecoverEvalEventsResult> {
  // 1. Aggregate cost_ledger per (installation_id, job_id) for this
  //    installation. The `provider` / `model` columns are picked via
  //    MAX so a job with retry rows under the same model still
  //    surfaces a stable label.
  const candidateRows = await db
    .select({
      jobId: costLedger.jobId,
      provider: sql<string>`MAX(${costLedger.provider})`,
      model: sql<string>`MAX(${costLedger.model})`,
      latencyMs: sql<number>`COALESCE(SUM(${costLedger.latencyMs}), 0)::int`,
      costUsd: sql<number>`COALESCE(SUM(${costLedger.costUsd}), 0)::double precision`,
      inputTokens: sql<number>`COALESCE(SUM(${costLedger.inputTokens}), 0)::int`,
      outputTokens: sql<number>`COALESCE(SUM(${costLedger.outputTokens}), 0)::int`,
    })
    .from(costLedger)
    .where(
      and(
        eq(costLedger.installationId, opts.installationId),
        opts.since ? gte(costLedger.createdAt, opts.since) : undefined,
      ),
    )
    .groupBy(costLedger.jobId);

  if (candidateRows.length === 0) {
    return { status: 'ok', candidates: 0, recovered: 0, skippedExisting: 0 };
  }

  // 2. Find which `job_id`s already exist in review_eval_event so we
  //    skip them on insert (idempotency contract).
  const candidateJobIds = candidateRows.map((r) => r.jobId);
  const existingRows = await db
    .select({ jobId: reviewEvalEvent.jobId })
    .from(reviewEvalEvent)
    .where(
      and(
        eq(reviewEvalEvent.installationId, opts.installationId),
        inArray(reviewEvalEvent.jobId, candidateJobIds),
      ),
    );
  const existing = new Set(existingRows.map((r) => r.jobId));
  const fresh = candidateRows.filter((r) => !existing.has(r.jobId));

  if (opts.dryRun || fresh.length === 0) {
    return {
      status: 'ok',
      candidates: candidateRows.length,
      recovered: 0,
      skippedExisting: existing.size,
    };
  }

  // 3. Insert. We use a single multi-row insert keyed by job_id so a
  //    concurrent recovery attempt has a deterministic ordering; the
  //    idempotency check above lets a re-run with overlapping jobs
  //    no-op cleanly.
  await db.insert(reviewEvalEvent).values(
    fresh.map((r) => ({
      installationId: opts.installationId,
      jobId: r.jobId,
      // cost_ledger doesn't carry these; fill with the CLI's --repo
      // arg + empty markers. Documented as best-effort recovery
      // (#105 Q1).
      repo: opts.repo,
      prNumber: 0,
      headSha: '',
      provider: r.provider,
      model: r.model,
      commentCount: 0,
      severityDist: {},
      confidenceDist: {},
      droppedDuplicates: 0,
      droppedByFeedback: 0,
      toolCalls: 0,
      latencyMs: r.latencyMs,
      costUsd: r.costUsd,
      tokensInput: r.inputTokens,
      tokensOutput: r.outputTokens,
      abortReason: null,
    })),
  );

  return {
    status: 'ok',
    candidates: candidateRows.length,
    recovered: fresh.length,
    skippedExisting: existing.size,
  };
}
