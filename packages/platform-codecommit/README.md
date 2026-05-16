# @review-agent/platform-codecommit

AWS CodeCommit VCS adapter for `review-agent`. Implements the `VCS` interface
from `@review-agent/core` against `@aws-sdk/client-codecommit`.

## Status

Functional but limited — see **Caveats** below. CodeCommit is in maintenance
mode (no new features per AWS); this adapter targets parity with the
GitHub adapter, not feature-on-feature.

## Authentication

**STS only.** No long-lived AWS access keys in code or env. Pick one of:

- IAM role attached to the Lambda / Fargate task running the worker.
- `AWS_PROFILE` (with `~/.aws/credentials` populated by `aws sso login`)
  for local development.
- Web Identity Federation when running in EKS / ECS.

The default `CodeCommitClient({})` configuration walks the standard SDK
credential provider chain. Pass an explicit `clientConfig` only when you
need to override region or profile from your wiring.

## IAM permissions

Spec §8.4. The minimum permissions for the worker IAM role are:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "codecommit:GetPullRequest",
        "codecommit:GetDifferences",
        "codecommit:GetFile",
        "codecommit:GetCommentsForPullRequest",
        "codecommit:PostCommentForPullRequest",
        "codecommit:PostCommentReply",
        "codecommit:UpdatePullRequestApprovalState"
      ],
      "Resource": "arn:aws:codecommit:<region>:<account>:<repository>"
    }
  ]
}
```

Replace `<region>`, `<account>`, and `<repository>` with the appropriate
ARN. Use a wildcard repository name only when the agent is scoped to a
whole account.

## State storage caveat (§5.2 + §12.1.1)

GitHub reviews persist `<!-- review-agent-state: ... -->` markers inside a
hidden review-summary comment. CodeCommit's HTML escaping mangles those
markers, so **CodeCommit cannot use comment-based state**.

This adapter therefore:

- Returns `null` from `getStateComment()` always.
- No-ops `upsertStateComment()`.

The runner reads / writes state from the Postgres `review_state` mirror
instead (see `@review-agent/db`'s `createReviewStateMirror` and the
`loadReviewState` resolver). Without Postgres, the agent has **no
incremental review memory** for CodeCommit repos.

## Disaster recovery

The GitHub adapter ships a `recover sync-state-from-hidden-comment` path
that rebuilds the Postgres mirror from the canonical hidden-state comment.
There is **no equivalent for CodeCommit** — when Postgres is lost, the
next review is a full re-run.

Operational implications:

- Take regular Postgres backups (RDS automated snapshots, Aurora
  point-in-time recovery, ...).
- Treat the worker's Postgres connection as a hard dependency. Without
  it, every PR review is full-cost and the dedup pass cannot suppress
  comments that were already posted on a prior review.

This trade-off is documented in `docs/deployment/aws.md` under the
"CodeCommit disaster recovery" section.

## Merge-blocking via approval state (opt-in, #74)

By default the adapter posts inline comments and a summary, but ignores
`review.event` — preserving the v0.2 behavior where merge-blocking on
CodeCommit is left entirely to operator-managed approval rules.

When `codecommit.approvalState: 'managed'` is set in `.review-agent.yml`
(or `approvalState: 'managed'` is passed to `createCodecommitVCS`), the
adapter additionally maps `review.event` onto CodeCommit's
[`UpdatePullRequestApprovalState`](https://docs.aws.amazon.com/codecommit/latest/APIReference/API_UpdatePullRequestApprovalState.html)
API:

| `review.event`     | Adapter action                                       |
| ------------------ | ---------------------------------------------------- |
| `APPROVE`          | `UpdatePullRequestApprovalState(APPROVE)`            |
| `REQUEST_CHANGES`  | `UpdatePullRequestApprovalState(REVOKE)`             |
| `COMMENT` / unset  | no-op                                                |

**IAM precondition** — the API only has an effect when the agent's IAM
principal is a target of an approval rule on the PR (either via an
`ApprovalRuleTemplate` associated with the repository, or a per-PR
`CreatePullRequestApprovalRule`). When no rule applies, the SDK raises a
typed error (`ApprovalRuleDoesNotExistException` /
`InvalidApprovalStateException`); the adapter catches it, logs at
`warn`, and continues — the inline comments and summary that were posted
beforehand stay in place. This is a deliberate degrade-non-fatal path so
operators can roll out the opt-in before wiring the approval rule.

To actually block merges, attach a branch-protection-like approval rule
to the repository (or the specific PR) that requires approval from the
IAM principal the agent runs as.

## Limitations

- `cloneRepo()` throws. The adapter does not shell out to git for
  CodeCommit clones; the runner's diff-driven flow uses `getDiff()` and
  `getFile()` instead. If your skill scripts genuinely require a working
  copy, run them outside of this adapter.
- `additions` / `deletions` / `patch` on `DiffFile` are zeroed / null —
  the CodeCommit `GetDifferences` API does not return per-file line
  counts or unified diff text. This is a v0.2 limitation, not a bug.
- `pullRequestId` is converted from `PRRef.number` via `String(...)`.
  CodeCommit IDs are positive integers in practice, so the round-trip is
  lossless, but never store a value larger than `Number.MAX_SAFE_INTEGER`.

## Usage

```ts
import { createCodecommitVCS } from '@review-agent/platform-codecommit';

// Default credential chain — picks up the IAM role on Lambda / EC2 /
// Fargate, or AWS_PROFILE / AWS_SSO when running locally.
const vcs = createCodecommitVCS();

// Or override the client (useful for tests or alternate region):
import { CodeCommitClient } from '@aws-sdk/client-codecommit';
const vcs2 = createCodecommitVCS({
  client: new CodeCommitClient({ region: 'us-west-2' }),
});

const pr = await vcs.getPR({
  platform: 'codecommit',
  owner: '',          // CodeCommit has no owner-level namespace; empty string is fine
  repo: 'demo-repo',
  number: 42,
});
```

## See also

- Spec §5.2 VCS interface + CodeCommit caveat
- Spec §7.1 CodeCommit SNS signature verification (server-side, separate package)
- Spec §10.3 PR comment commands (CodeCommit `commentOnPullRequest` mapping)
- Spec §12.1.1 Postgres-only state for CodeCommit
- Spec §15.1 AWS Lambda example (CodeCommit-aware worker)
