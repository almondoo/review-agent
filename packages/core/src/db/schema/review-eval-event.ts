import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgPolicy,
  pgTable,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';
import { appRole } from './roles.js';

/**
 * Per-review evaluation event (spec v1.2 epic #83 Phase 2). One row
 * per `runReview` invocation, recorded by the runner's eval recorder
 * after the agent loop finishes. The `cost_ledger` table records
 * per-LLM-call rows; this table is the per-review summary so the
 * eval harness can correlate cost / latency / comment distribution
 * with downstream feedback signals (Phase 3 / 4).
 *
 * RLS mirrors `cost_ledger` / `review_history` — tenant isolation
 * by `installation_id`.
 */
export const reviewEvalEvent = pgTable(
  'review_eval_event',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    installationId: bigint('installation_id', { mode: 'bigint' }).notNull(),
    jobId: text('job_id').notNull(),
    repo: text('repo').notNull(),
    prNumber: integer('pr_number').notNull(),
    headSha: text('head_sha').notNull(),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    commentCount: integer('comment_count').notNull().default(0),
    /**
     * `{ critical: n, high: n, medium: n, low: n, style: n }` — counts
     * over the posted comments (post-dedup, post-confidence-filter,
     * post-redaction). Stored as JSONB so adding a severity tier
     * later does not require a schema migration.
     */
    severityDist: jsonb('severity_dist').notNull().default(sql`'{}'::jsonb`),
    /**
     * `{ high: n, medium: n, low: n }` — counts of posted comments by
     * `confidence` (default `high` when the LLM omits the field;
     * mirrors the runtime's `min_confidence` interpretation).
     */
    confidenceDist: jsonb('confidence_dist').notNull().default(sql`'{}'::jsonb`),
    droppedDuplicates: integer('dropped_duplicates').notNull().default(0),
    /**
     * Comments suppressed because their fingerprint matches a prior
     * `factType: 'rejected_finding'` row in `review_history` (Phase 4
     * wiring). Stays at zero until Phase 4 lands.
     */
    droppedByFeedback: integer('dropped_by_feedback').notNull().default(0),
    toolCalls: integer('tool_calls').notNull().default(0),
    /**
     * Wall-clock time the runner spent inside `runReview` (gitleaks
     * pre-scan + LLM call(s) + middleware + dedup + output scan).
     * Mirrors the `latency_ms` column added to `cost_ledger` so the
     * per-review summary doesn't require a join when reading.
     */
    latencyMs: integer('latency_ms').notNull().default(0),
    costUsd: doublePrecision('cost_usd').notNull().default(0),
    tokensInput: integer('tokens_input').notNull().default(0),
    tokensOutput: integer('tokens_output').notNull().default(0),
    /**
     * Nullable when the review posted normally; set to a
     * `REVIEW_ABORT_REASONS` value (`url_allowlist`,
     * `schema_violation`, `max_files_exceeded`, `max_diff_lines_exceeded`)
     * when the agent loop gracefully aborted. Free-text rather than
     * a typed enum so future abort reasons don't require migration.
     */
    abortReason: text('abort_reason'),
    /**
     * Total number of files in the PR diff after path-filter exclusions
     * but before LLM review (i.e., the universe the runner was asked to
     * review). Nullable for back-compat with rows recorded before
     * migration 0013. When null, coverage cannot be computed for this row.
     */
    filesTotal: integer('files_total'),
    /**
     * Number of files actually handed to the LLM for this review.
     * Equals `filesTotal` minus files excluded by max_files / max_diff_lines /
     * max_chunks / budget caps. Nullable for back-compat.
     */
    filesReviewed: integer('files_reviewed'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('review_eval_event_installation_repo_idx').on(t.installationId, t.repo),
    index('review_eval_event_created_at_idx').on(t.createdAt),
    index('review_eval_event_job_idx').on(t.installationId, t.jobId),
    pgPolicy('tenant_isolation', {
      as: 'permissive',
      to: appRole,
      for: 'all',
      using: sql`${t.installationId}::text = current_setting('app.current_tenant', true)`,
      withCheck: sql`${t.installationId}::text = current_setting('app.current_tenant', true)`,
    }),
  ],
).enableRLS();

export type ReviewEvalEventRow = typeof reviewEvalEvent.$inferSelect;
export type NewReviewEvalEventRow = typeof reviewEvalEvent.$inferInsert;
