---
'@review-agent/platform-codecommit': patch
'@review-agent/server': patch
'@review-agent/cli': patch
'@review-agent/db': patch
---

#113 — CodeCommit `/feedback` recovery: apply allowlist to reply authors

The disaster-recovery CLI `review-agent recover feedback-history --platform codecommit` (added in #110) previously checked only the parent comment's author against `--bot-arn` — the reply author was never inspected against `REVIEW_AGENT_FEEDBACK_ALLOWLIST`. An attacker with `codecommit:PostCommentForPullRequest` whose live `/feedback` replies were denied could therefore have those replies silently re-promoted into `review_history` the next time the operator ran the recovery CLI, biasing future `<learned_facts>` and suppressing real findings via the dedup middleware.

**@review-agent/platform-codecommit**

- New `authz.ts` module — `checkCodeCommitFeedbackAuthz`, `parseAllowlist`, fail-closed semantics — lifted from `@review-agent/server` so the recovery CLI can apply the same check.

**@review-agent/server**

- `feedback-authz.ts` now re-exports the CodeCommit authz from `@review-agent/platform-codecommit`. Public surface unchanged.

**@review-agent/cli**

- `scrapeCodeCommitFeedback` now requires `feedbackAllowlist: readonly string[]` and rejects replies whose author ARN is not on the allowlist (or is missing). Stats gain an `unauthorized` counter, surfaced in the run summary.
- `recover feedback-history --platform codecommit` reads `REVIEW_AGENT_FEEDBACK_ALLOWLIST` from the environment, mirroring the live webhook. An unset / empty allowlist emits a stderr warning and fails closed.

**@review-agent/db**

- Widened `RecoverFeedbackHistoryResult.status` to `'ok' | 'partial'` so the CodeCommit recovery CLI can surface allowlist-denied / fail-closed runs as non-zero exit status (#113 fix). No runtime behaviour change; type-level additive change.
