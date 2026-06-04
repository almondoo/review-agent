import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  index,
  integer,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';
import { appRole } from './roles.js';

/**
 * Tracks per-thread conversation turn counts for the `@review-agent`
 * inline-reply feature (#149).
 *
 * Natural key: `(installation_id, repo, pr_number, root_comment_id)`.
 * The surrogate `id` bigserial PK exists for upsert target compatibility
 * with Drizzle's `onConflictDoUpdate`; the unique constraint on the
 * natural key drives the actual "upsert on this thread" semantics.
 *
 * - `root_comment_id` is the id of the original bot finding comment
 *   the user is replying into (GitHub's `pull_request_review_comment.id`
 *   on the first comment that started the thread). All replies in that
 *   thread share the same root.
 * - `turn_count` counts agent replies posted in the thread. When it
 *   reaches `max_conversation_turns` the agent posts a single
 *   "conversation limit reached" note and stops.
 * - RLS `tenant_isolation` policy follows the same pattern as all other
 *   tenant-scoped tables (§16.1).
 */
export const conversationThreads = pgTable(
  'conversation_threads',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    installationId: bigint('installation_id', { mode: 'bigint' }).notNull(),
    repo: text('repo').notNull(),
    prNumber: integer('pr_number').notNull(),
    rootCommentId: text('root_comment_id').notNull(),
    turnCount: integer('turn_count').notNull().default(0),
    lastTurnAt: timestamp('last_turn_at', { withTimezone: true }).defaultNow().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    unique('conversation_threads_key_uniq').on(
      t.installationId,
      t.repo,
      t.prNumber,
      t.rootCommentId,
    ),
    index('conversation_threads_last_turn_at_idx').on(t.lastTurnAt),
    pgPolicy('tenant_isolation', {
      as: 'permissive',
      to: appRole,
      for: 'all',
      using: sql`${t.installationId}::text = current_setting('app.current_tenant', true)`,
      withCheck: sql`${t.installationId}::text = current_setting('app.current_tenant', true)`,
    }),
  ],
).enableRLS();

export type ConversationThreadRow = typeof conversationThreads.$inferSelect;
export type NewConversationThreadRow = typeof conversationThreads.$inferInsert;
