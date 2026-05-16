/**
 * Registry of `{ AWS SDK Command class, codecommit:* IAM permission }` pairs
 * for the CodeCommit adapter. Source of truth: spec §8.4 + the IAM block in
 * `packages/platform-codecommit/README.md`.
 *
 * Why this file exists:
 *
 * The CodeCommit adapter calls `client.send(new <X>Command(...))` for each
 * AWS API it relies on. Each Command requires a corresponding `codecommit:*`
 * action on the worker's IAM role. If a new `*Command` is added to
 * `adapter.ts` without updating spec §8.4 / README, operators hit
 * `AccessDenied` errors that are painful to diagnose. The companion
 * `iam-drift.test.ts` enforces parity between this registry, the adapter
 * source, and the README IAM block.
 *
 * When you add a new SDK Command to the adapter:
 *   1. Append a `{ command, permission }` pair here.
 *   2. Add the matching `codecommit:<Action>` line to:
 *      - spec §8.4 (`docs/specs/review-agent-spec.md`)
 *      - the IAM JSON block in `packages/platform-codecommit/README.md`
 *   3. Re-run `pnpm --filter @review-agent/platform-codecommit test`.
 *
 * Some entries below correspond to Commands that are listed in the IAM
 * block but not yet exercised in `adapter.ts` (e.g. `PostCommentReply`,
 * and — until issue #74 lands — `UpdatePullRequestApprovalState`). They
 * remain in the registry so docs and ops never lag the planned surface.
 */

export type ExpectedCommandPair = {
  readonly command: string;
  readonly permission: string;
};

export const EXPECTED_COMMANDS = [
  { command: 'GetPullRequestCommand', permission: 'codecommit:GetPullRequest' },
  { command: 'GetDifferencesCommand', permission: 'codecommit:GetDifferences' },
  { command: 'GetFileCommand', permission: 'codecommit:GetFile' },
  {
    command: 'GetCommentsForPullRequestCommand',
    permission: 'codecommit:GetCommentsForPullRequest',
  },
  {
    command: 'PostCommentForPullRequestCommand',
    permission: 'codecommit:PostCommentForPullRequest',
  },
  { command: 'PostCommentReplyCommand', permission: 'codecommit:PostCommentReply' },
  {
    command: 'UpdatePullRequestApprovalStateCommand',
    permission: 'codecommit:UpdatePullRequestApprovalState',
  },
] as const satisfies ReadonlyArray<ExpectedCommandPair>;

/**
 * The set of `codecommit:*` action strings the worker's IAM role must
 * grant. Derived from `EXPECTED_COMMANDS` so the two never drift.
 */
export const EXPECTED_PERMISSIONS: ReadonlySet<string> = new Set(
  EXPECTED_COMMANDS.map((pair) => pair.permission),
);

/**
 * Commands that the registry intentionally lists ahead of adapter usage.
 * They appear in the IAM block (spec / README) but are not yet wired in
 * `adapter.ts`. The drift test treats these as expected-but-unused so
 * "Command in registry without code reference" does not false-positive.
 */
export const PENDING_COMMANDS: ReadonlySet<string> = new Set([
  // Used by reply-on-comment flows (spec §10.3); not wired yet.
  'PostCommentReplyCommand',
  // Issue #74 will wire this; we list it here so the IAM block stays
  // ahead of the code rather than behind.
  'UpdatePullRequestApprovalStateCommand',
]);
