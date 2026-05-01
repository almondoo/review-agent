import { sql } from 'drizzle-orm';
import {
  bigint,
  jsonb,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import type { ReviewState } from '../../review.js';
import { appRole } from './roles.js';

export const reviewState = pgTable(
  'review_state',
  {
    id: text('id').primaryKey(),
    installationId: bigint('installation_id', { mode: 'bigint' }).notNull(),
    prId: text('pr_id').notNull(),
    headSha: text('head_sha').notNull(),
    state: jsonb('state').$type<ReviewState>().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('review_state_installation_pr_idx').on(t.installationId, t.prId),
    pgPolicy('tenant_isolation', {
      as: 'permissive',
      to: appRole,
      for: 'all',
      using: sql`${t.installationId}::text = current_setting('app.current_tenant', true)`,
      withCheck: sql`${t.installationId}::text = current_setting('app.current_tenant', true)`,
    }),
  ],
).enableRLS();

export type ReviewStateRow = typeof reviewState.$inferSelect;
export type NewReviewStateRow = typeof reviewState.$inferInsert;
