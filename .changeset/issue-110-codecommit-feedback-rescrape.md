---
'@review-agent/platform-codecommit': minor
'@review-agent/core': patch
'@review-agent/cli': minor
---

#110 — CodeCommit `/feedback` re-scrape for disaster recovery.

Extends `recover feedback-history` (#105) to support `--platform
codecommit` by walking PR comments directly via the CodeCommit SDK.
Carved out of #105 because it required adding CodeCommit adapter
pagination (`ListPullRequests`) and an `inReplyTo`-aware comment walk
that is orthogonal to the GitHub recovery path.

**`@review-agent/platform-codecommit`** (new exports):

- `listCodeCommitPullRequestIds(client, opts)` — paginated walk of
  every PR id in a repository (open / closed / all). Deduplicates
  across status passes.
- `listCodeCommitCommentsForPullRequest(client, opts)` — paginated
  comment list for a single PR. Preserves `inReplyTo` and
  `creationDate` so the recovery walk can resolve replies to their
  parent Bot comment.
- `createDefaultCodeCommitClient(cfg?)` — constructs a default
  `CodeCommitClient` from the standard AWS SDK credential / region
  chain. Allows the CLI to build a client without pulling
  `@aws-sdk/client-codecommit` as a direct dependency.

**`@review-agent/core`** (`ExistingComment.inReplyTo?: string`):

Backwards-compatible additive field. CodeCommit adapter populates it
from the SDK Comment's `inReplyTo` field; GitHub adapter leaves it
unset (GitHub exposes the same relationship via
`pull_request_review_comment.in_reply_to_id`, but only on the
review-comment endpoint — out of scope for this change).

**`@review-agent/cli`** (`recover feedback-history --platform codecommit`):

New flow: walks every PR, paginates comments, finds `/feedback`
commands, resolves each reply to its parent Bot comment via
`inReplyTo` → `extractFingerprintFromComment` (the #96 marker).
Skips unresolvable replies (no `inReplyTo`, or parent missing the
marker) and reports them in the run summary's `unresolved` counter.
Idempotent against existing `review_history.fact_text` via the
existing `recoverFeedbackHistory` helper (#105).

New CLI flags on `recover feedback-history`:
- `--since <YYYY-MM-DD>` — filter by comment creation date.
- `--pr <n>` — single-PR debug scope (skips `ListPullRequests`).
- `--rate <req-per-sec>` — pacing for the SDK walk (default 2 req/sec).

**IAM**: the worker / recovery role now needs `codecommit:ListPullRequests`
in addition to the existing CodeCommit permissions. Updated in:

- `packages/platform-codecommit/README.md` IAM block
- spec §8.4
- `packages/platform-codecommit/src/iam.ts` registry (kept in sync
  by `iam-drift.test.ts`)

Locked design decisions (issue #110 body):
- Q1 rate: default 2 req/sec, operator-tunable via `--rate`.
- Q2 scope: default all PRs; `--since` filters by comment creation
  date; `--pr <n>` for debug.
- Q3 resolution failure: `skip + count`, never abort the run.
- Q4 dedup: full `fact_text` equality via `recoverFeedbackHistory`
  (#105 helper).
- Q5 prefix-arg resolution: out of scope for the CLI (needs a DB
  lookup against `review_state.commentFingerprints`; the webhook
  receiver is the right place for that path).
