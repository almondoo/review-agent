---
'@review-agent/cli': minor
'@review-agent/runner': patch
'@review-agent/platform-codecommit': patch
'@review-agent/core': patch
'@review-agent/db': patch
---

#110 — CodeCommit `/feedback` re-scrape security hardening.

Follows the initial `--platform codecommit` recovery flow with ten
hardening fixes pulled from the PR review (#110). The shape of the
public `recover feedback-history` command is preserved; one new flag
(`--bot-arn`) is required when the recovery path actually walks
CodeCommit (no impact on `--platform github`).

**`@review-agent/cli`** (breaking when run against CodeCommit):

- `recover feedback-history --platform codecommit` now requires
  `--bot-arn <arn>`. The recovery walk only treats a parent comment
  as fingerprint-bearing when its `authorArn` equals this principal,
  so a reviewer cannot launder arbitrary text into `review_history`
  by self-replying `/feedback` to a hand-crafted parent.
- `--since` is validated against the same ISO-date regex the
  `feedback backfill` command uses. Malformed values
  (`2026/05/01`, junk strings) early-return with stderr.
- `--rate` rejects non-finite / non-positive values; `Infinity` /
  `NaN` / `<= 0` fall back to the 500ms default with a warning.
- `--repo` for CodeCommit accepts either `<name>` or `<owner>/<name>`.
  The DB key is always normalized to `${installationId}/${name}`, so
  an operator typo in the owner prefix cannot shadow another tenant's
  rows. The mismatch is reported to stderr.
- `--pr` (recover feedback-history) is parsed with a strict
  `^\d+$` guard via Commander's `InvalidArgumentError`. `--pr 100abc`
  no longer silently coerces to `100`.
- The persisted `factText` is now structured — `[fp:<fp>]
  codecommit-recover <kind> at <iso>` — and never includes the
  reviewer's free-text body. Closes precedent for secrets / PII /
  prompt-injection laundering through `<learned_facts>`.

**`@review-agent/runner`** (`review_history.repo` normalization):

- CodeCommit PRs (`PRRef.owner === ''`) no longer produce a `/foo`
  DB key. The runner substitutes `installationId` so reads and
  writes share the `${installationId}/${repo}` shape with the
  recovery CLI. GitHub keys are unchanged.

**`@review-agent/platform-codecommit`**:

- `CodeCommitRawComment.authorArn?` field added; populated by
  `listCodeCommitCommentsForPullRequest` from the SDK response.
  Backwards-compatible additive field; the CLI recovery path uses
  it for the Bot-ARN gate above.
- `listCodeCommitPullRequestIds` rejects PR id strings that aren't
  pure decimal integers (`"42-archived"` would previously coerce
  to `42`).

**`@review-agent/db`** (migration 0004):

- Migration `0004_lonely_zinc_aristocrat.sql` rewrites every legacy
  `review_history.repo = '/foo'` row to `'${installation_id}/foo'`
  so post-migration reads against the new normalized key still see
  the historical rows. Only rows whose repo literally starts with
  `'/'` are touched; GitHub installations are unaffected.

**Operational notes**:

- After applying migration 0004, the runtime keeps writing the
  normalized shape; the recovery CLI now reads / writes the same
  shape unconditionally.
- The `--bot-arn` value should match the worker's IAM role / user
  ARN (the principal posting Bot comments through
  `PostCommentForPullRequest`).
- No IAM permission changes — the Bot-ARN gate uses data the SDK
  already returns on `GetCommentsForPullRequest`.
