-- v1.2 #110 — CodeCommit `review_history.repo` normalization.
--
-- Before this migration, the runtime CodeCommit path wrote
-- `review_history.repo` as `'/foo'` because the adapter sets
-- `PRRef.owner === ''` (CodeCommit has no owner segment).
-- Rows from different AWS accounts sharing the same repo name
-- collided on `(installation_id, repo)` lookups, even though RLS
-- isolated reads by `installation_id`.
--
-- Forward-fix: the runner now substitutes the numeric AWS account
-- id (`installationId`) as the owner segment, producing
-- `'${installation_id}/foo'`. This migration rewrites every legacy
-- `'/foo'` row to the same shape so reads and writes converge.
--
-- Only rows whose `repo` literally starts with `'/'` are touched —
-- GitHub installations are unaffected.
UPDATE review_history
   SET repo = installation_id::text || repo
 WHERE repo LIKE '/%';
