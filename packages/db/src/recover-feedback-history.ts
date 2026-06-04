import { type ReviewHistoryFactType, reviewHistory } from '@review-agent/core/db';
import { and, eq } from 'drizzle-orm';
import type { DbClient } from './connection.js';

/**
 * v1.2 #105 — `recover feedback-history` (GitHub only) helper.
 *
 * Idempotency layer over the existing `createReviewHistoryWriter`.
 * The caller (CLI `recover feedback-history --platform github`)
 * collects candidate `(factType, factText)` events from the GitHub
 * reactions API (same source as #99 `feedback backfill`) and passes
 * them here. We:
 *
 *   1. Snapshot the existing `review_history` rows for the scoped
 *      `(installation_id, repo)` so duplicate `fact_text` is not
 *      re-inserted.
 *   2. Insert only the candidates whose `fact_text` is missing from
 *      the snapshot.
 *
 * The `--platform codecommit` path is reject-only in v1.2: the
 * CodeCommit `/feedback` re-scrape is carved out as issue #110.
 * This module never sees a CodeCommit candidate.
 *
 * Idempotency key: full `fact_text` equality. The Phase 3 writer
 * encodes `[fp:<fingerprint>] <redacted text>` so the prefix alone
 * makes two events on the same fingerprint collide reliably. A
 * future migration could promote this to a unique index on
 * `(installation_id, repo, fact_text)` — for now we serialise the
 * dedup in code so existing rows are not retro-rejected.
 */
export type RecoverFeedbackHistoryCandidate = {
  readonly factType: ReviewHistoryFactType;
  readonly factText: string;
};

export type RecoverFeedbackHistoryOpts = {
  readonly installationId: bigint;
  readonly repo: string;
  readonly candidates: ReadonlyArray<RecoverFeedbackHistoryCandidate>;
  readonly dryRun?: boolean;
};

export type RecoverFeedbackHistoryResult = {
  /**
   * `'ok'`: clean run — every observed `/feedback` reply either resolved
   * to a candidate or was skipped for a benign reason (unresolved /
   * orphaned / pre-marker).
   *
   * `'partial'` (v1.2 #113): the CLI downgrades to `'partial'` when the
   * CodeCommit branch surfaces a non-clean recovery — either
   * `scrape.stats.unauthorized > 0` (the allowlist denied at least one
   * reply that reached the authz gate), or the operator forgot to set
   * `REVIEW_AGENT_FEEDBACK_ALLOWLIST` while at least one `/feedback`
   * command was observed (incomplete cron-time configuration; a future
   * re-run with the env set could recover authorized replies). The two
   * arms are independent — the second can fire with `unauthorized === 0`
   * when every command exited via an earlier gate. Lets cron callers
   * checking `$?` distinguish "no feedback" from "feedback present but
   * silently denied or unrecoverable". The helper itself only ever
   * returns `'ok'`; the downgrade is layered on by the CLI.
   */
  readonly status: 'ok' | 'partial';
  readonly candidates: number;
  readonly recovered: number;
  readonly skippedExisting: number;
};

export async function recoverFeedbackHistory(
  db: DbClient,
  opts: RecoverFeedbackHistoryOpts,
): Promise<RecoverFeedbackHistoryResult> {
  if (opts.candidates.length === 0) {
    return { status: 'ok', candidates: 0, recovered: 0, skippedExisting: 0 };
  }
  const existing = await db
    .select({ factText: reviewHistory.factText })
    .from(reviewHistory)
    .where(
      and(eq(reviewHistory.installationId, opts.installationId), eq(reviewHistory.repo, opts.repo)),
    );
  const existingSet = new Set(existing.map((r) => r.factText));

  const fresh = opts.candidates.filter((c) => !existingSet.has(c.factText));
  if (opts.dryRun || fresh.length === 0) {
    return {
      status: 'ok',
      candidates: opts.candidates.length,
      recovered: 0,
      skippedExisting: opts.candidates.length - fresh.length,
    };
  }

  await db.insert(reviewHistory).values(
    fresh.map((c) => ({
      installationId: opts.installationId,
      repo: opts.repo,
      factType: c.factType,
      factText: c.factText,
    })),
  );

  return {
    status: 'ok',
    candidates: opts.candidates.length,
    recovered: fresh.length,
    skippedExisting: opts.candidates.length - fresh.length,
  };
}
