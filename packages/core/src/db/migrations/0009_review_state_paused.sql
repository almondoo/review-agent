-- Migration 0009: add `paused` column to `review_state` (#157 trigger control).
--
-- The `/skip` command sets `paused = true`; `/resume` clears it back to `false`.
-- Auto-review paths check this flag and skip enqueueing when `paused IS TRUE`.
-- Defaults to `false` (NOT NULL) so existing rows continue to behave as active
-- without a data migration.
--
-- The column is added with `DEFAULT false NOT NULL` so Postgres fills existing
-- rows immediately without a full-table rewrite on a server with few rows, and
-- the NOT NULL constraint is satisfied from the first write.

ALTER TABLE "review_state" ADD COLUMN "paused" boolean DEFAULT false NOT NULL;
