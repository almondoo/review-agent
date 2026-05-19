---
'@review-agent/core': minor
'@review-agent/llm': patch
'@review-agent/runner': minor
'@review-agent/config': patch
'@review-agent/platform-github': minor
'@review-agent/platform-codecommit': patch
'@review-agent/server': minor
'@review-agent/cli': patch
'@review-agent/db': minor
'@review-agent/action': patch
'@review-agent/eval': minor
---

v1.2 wave — continuous review evaluation & improvement loop + audit cleanup (11 issues + follow-on test scaffolding, shipped on `develop`).

For the canonical state of this wave see [`docs/roadmap.md`](../docs/roadmap.md). Issue links and operator-runtime backlog live there; this file is intentionally a short release note.

**v1.2 epic (#83) — closed loop: review → measure → learn → improved review**:

- #90 (Phase 1) — promptfoo → severity-scoring shim + `baseline-measure` CLI + unconditional severity-consistency CI gate. End-to-end gate test simulates happy / regression / null-baseline / improvement paths without burning the Anthropic budget.
- #91 (Phase 2) — new `review_eval_event` table (per-review metrics, RLS-isolated) + `EvalMiddleware` + `cost_ledger.latency_ms`. Fail-open recorder so a transient DB outage never aborts a successfully-posted review.
- #92 (Phase 3) — `createFeedbackWriter` (PII redact + 10/job rate-limit + `[fp:<fingerprint>]` prefix) + GitHub webhook reaction / dismissed signal classification + `createReviewHistoryWriter` + `startReviewHistoryCleanup` advisory-lock-elected TTL prune (180-day, separate from idempotency cleanup).
- #93 (Phase 4) — `<learned_facts>` injection in `composeSystemPrompt` (grouped by `factType` with positive / negative / context framing) + feedback-aware dedup (`droppedByFeedback` counter) + threading through eval recorder.

**Audit cleanup (#84) + Section B "spec-defined-but-unused config" follow-ons**:

- #85 — URL allowlist refine in `ReviewOutputSchema` (`privacy.allowed_url_prefixes` + own-repo auto-allow + retry-once-then-graceful-abort).
- #86 — `privacy.deny_paths` applied to `read_file` / `glob` / `grep` tool dispatch (extend, not relax).
- #87 — `privacy.redact_patterns` injected as gitleaks custom rules (`custom-N`) + applied to both quickScan and post-LLM redaction.
- #88 — `reviews.{path_filters, max_files, max_diff_lines}` enforced before gitleaks + LLM call (zero-cost cap skip with graceful summary).
- #89 — `repo.{submodules, lfs}` wired into `ProvisionWorkspaceInput.cloneHints` → `CloneOpts`; LFS defaults to `GIT_LFS_SKIP_SMUDGE=1`.
- #84 — Section A dead code (`shiftLineThroughHunks` + `ApplyLineShiftInput`) removed.

**v1.2 follow-on test scaffolding** (no operator runtime needed):

- `feature-dev` wave-end pass — db unit tests for `createReviewEvalEventRecorder` + `createReviewHistoryWriter`, `startReviewHistoryCleanup` worker tests with distinct advisory lock key, end-to-end severity-consistency gate test (4 scenarios), RLS / TTL integration tests gated on `TEST_DATABASE_APP_URL`.

**Migration notes** (full procedure: #100):

- New migration `0003_review_eval_event.sql` adds the `review_eval_event` table + `cost_ledger.latency_ms` column. Forward-compatible — v1.1 code keeps running after the migration is applied (validated via #107 follow-on).
- New optional `runReview` deps (`evalRecorder` / `historyReader` / `evalContext` / `now` / `onEvalRecordError`) — all back-compat defaults; v1.1 callers compile unchanged.

**Active follow-on issues** (post-v1.2, see `docs/roadmap.md` for the full table):

- Implementation: #95 (CodeCommit `/feedback`), #96 (fingerprint embed), #99 (feedback backfill CLI), #101 (LLM-as-a-Judge), #105 (recover-sync-state v1.2), #106 (OTel metrics).
- Docs: #98 (worked-example handler), #100 (v1.1 → v1.2 migration guide), #103 (review_eval_event SQL playbook), #104 (SLO playbook).
- Test: #107 (migration compat suite), #108 (self-feedback E2E).
- Operator runtime (real API key / DB required): #97 (default baseline measurement), #102 (per-provider parity matrix).

Final regression: 1221 unit tests pass + 7 skipped (DB integration); typecheck / lint / build green across all 12 packages.
