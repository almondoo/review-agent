-- Migration 0013: coverage columns for issue #142 (quality metrics Phase A).
--
-- Adds two nullable integer columns to `review_eval_event`:
--   1. `files_total`    — total files in the PR diff after path-filter exclusions,
--                         i.e. the universe the runner was asked to review.
--   2. `files_reviewed` — files actually handed to the LLM (filesTotal minus
--                         files dropped by max_files / max_diff_lines / max_chunks /
--                         budget caps).
--
-- Both columns are nullable for backward compatibility. Rows recorded before
-- this migration will have NULL in both columns; the coverage rate query
-- excludes rows where files_total IS NULL or files_total = 0.
-- RLS policies on `review_eval_event` are unchanged.

ALTER TABLE "review_eval_event"
  ADD COLUMN IF NOT EXISTS "files_total" integer;
--> statement-breakpoint
ALTER TABLE "review_eval_event"
  ADD COLUMN IF NOT EXISTS "files_reviewed" integer;
