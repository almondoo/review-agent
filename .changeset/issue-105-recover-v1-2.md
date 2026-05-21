---
'@review-agent/db': minor
'@review-agent/cli': minor
---

#105 — `recover review-eval-events` + `recover feedback-history` (GitHub).

Two new CLI subcommands for CodeCommit disaster recovery of v1.2's
Postgres-canonical tables:

- `review-agent recover review-eval-events --installation-id N --repo owner/repo [--since YYYY-MM-DD] [--dry-run]`
  reconstructs `review_eval_event` rows by `(installation_id, job_id)`
  GROUP BY against `cost_ledger`. Financial fields (token/cost/latency)
  recover via SUM; LLM-output fields (comment_count, severity_dist,
  dropped_*) are best-effort blanks (locked design decision: those
  fields are not derivable from `cost_ledger`). Idempotent.

- `review-agent recover feedback-history --installation-id N --repo owner/repo --platform github --candidates-file <path>.jsonl [--dry-run]`
  takes an operator-supplied JSONL file of `{factType, factText}`
  candidates and inserts only the rows whose `fact_text` is not
  already present in `review_history`. Idempotent. `--platform codecommit`
  rejects with a pointer to issue #110.

New `@review-agent/db` exports:

- `recoverReviewEvalEvents(db, opts)` — pure helper, idempotent insert.
- `recoverFeedbackHistory(db, opts)` — pure helper, idempotent insert.

CodeCommit `/feedback` re-scrape (CodeCommit adapter pagination of
`getCommentsForPullRequest`) is carved out as issue #110 to keep #105
focused on the recovery semantic, not on adding new adapter
capabilities.

See `docs/operations/codecommit-disaster-recovery.md` § "Step 4.5 —
Recover v1.2 tables" for the full procedure + locked design decisions.
