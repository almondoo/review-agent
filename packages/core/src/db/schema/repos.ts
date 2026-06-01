import { boolean, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * Top-level repository registry. One row per VCS repository that
 * review-agent monitors. Soft-deletes via `deleted_at`; rows with a
 * non-null `deleted_at` are treated as removed by every query.
 *
 * Migration: `0005_repos_table.sql`.
 *
 * Columns added in the second schema revision (same migration batch):
 *   - `system_prompt`            text NULL  — per-repo system prompt override
 *   - `system_prompt_updated_at` timestamptz NULL — last prompt update time
 */
export const repos = pgTable('repos', {
  id: text('id').primaryKey(),
  platform: text('platform').notNull().$type<'github' | 'codecommit'>(),
  name: text('name').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  /**
   * Per-repo system prompt override. NULL or empty string means "inherit
   * the default prompt". The API surface treats both as equivalent.
   */
  systemPrompt: text('system_prompt'),
  /**
   * Timestamp of the last `PUT /api/repos/:id/prompt` write.
   * NULL when no custom prompt has ever been saved.
   */
  systemPromptUpdatedAt: timestamp('system_prompt_updated_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
});

export type RepoRow = typeof repos.$inferSelect;
export type NewRepoRow = typeof repos.$inferInsert;
