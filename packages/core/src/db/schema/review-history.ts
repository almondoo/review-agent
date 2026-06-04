import { sql } from 'drizzle-orm';
import { bigint, bigserial, index, pgPolicy, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { appRole } from './roles.js';

export const REVIEW_HISTORY_FACT_TYPES = [
  'accepted_pattern',
  'rejected_finding',
  'arch_decision',
  /**
   * False-positive suppression rule (#155). Created automatically by the
   * runner when the count of `rejected_finding` rows for the same
   * `[fp:<fingerprint>]` key reaches the `feedback.suppress_after` threshold
   * (default 3). Subsequent reviews skip any finding whose fingerprint matches
   * an active suppression rule.
   *
   * **180-day TTL**: inherits the same `expires_at` default as other rows.
   * Operators who want a permanent mute must re-create the row before it
   * expires (or run `review-agent suppression remove` then let the system
   * rebuild from fresh rejection signals). Documented in
   * `docs/operations/feedback-suppression.md`.
   */
  'suppression_rule',
] as const;
export type ReviewHistoryFactType = (typeof REVIEW_HISTORY_FACT_TYPES)[number];

export const reviewHistory = pgTable(
  'review_history',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    installationId: bigint('installation_id', { mode: 'bigint' }).notNull(),
    repo: text('repo').notNull(),
    factType: text('fact_type').notNull().$type<ReviewHistoryFactType>(),
    factText: text('fact_text').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true })
      .default(sql`now() + interval '180 days'`)
      .notNull(),
  },
  (t) => [
    index('review_history_installation_repo_idx').on(t.installationId, t.repo),
    index('review_history_expires_at_idx').on(t.expiresAt),
    pgPolicy('tenant_isolation', {
      as: 'permissive',
      to: appRole,
      for: 'all',
      using: sql`${t.installationId}::text = current_setting('app.current_tenant', true)`,
      withCheck: sql`${t.installationId}::text = current_setting('app.current_tenant', true)`,
    }),
  ],
).enableRLS();

export type ReviewHistoryRow = typeof reviewHistory.$inferSelect;
export type NewReviewHistoryRow = typeof reviewHistory.$inferInsert;
