/**
 * `/feedback` permission guard — v1.2 #95 (introduction), v1.2 #113
 * (recovery-path coverage).
 *
 * `/feedback accept|reject|dismiss` writes into `review_history`,
 * which the agent re-reads on subsequent reviews as
 * `<learned_facts>`. An attacker who can drop comments on a PR but
 * cannot push to the repo therefore has a low-cost path to poison
 * future review outputs unless we gate the command on **write
 * permission** to the repository.
 *
 *   - **CodeCommit** — there is no equivalent REST endpoint, so we
 *     start with an operator-managed CSV allowlist in
 *     `REVIEW_AGENT_FEEDBACK_ALLOWLIST`. Callers come from two
 *     CodeCommit event sources: the live webhook (SNS-delivered
 *     CodeCommit comment notifications, where `principalId` is lifted
 *     from `userIdentity.principalId`) and the CLI recovery walk
 *     (`review-agent recover feedback-history --platform codecommit`,
 *     which calls the CodeCommit SDK directly and feeds the reply's
 *     `authorArn` in as `principalId`). The same allowlist gates
 *     both paths. Fail closed: empty / unset allowlist denies every
 *     `/feedback`.
 *
 * Denied requests are **silently ignored** by the caller — surfacing
 * a public rejection comment would create a comment-forward DoS vector
 * (anyone could trigger an automated reply on every PR by spamming
 * `/feedback`).
 *
 * The reason string returned alongside `allowed: false` is for
 * structured logs only — never put it back on the PR.
 */

export type FeedbackAuthzResult = {
  readonly allowed: boolean;
  readonly reason?: string;
};

export type CodeCommitAuthzInput = {
  /**
   * The caller's IAM principal. Source depends on the callsite:
   *   - Live webhook: `userIdentity.principalId` from the SNS-delivered
   *     CodeCommit comment notification.
   *   - CLI recovery walk: the reply comment's `authorArn` lifted from
   *     the CodeCommit SDK response.
   * An empty / missing principal denies.
   */
  readonly principalId: string;
  /**
   * Override of the env-derived allowlist. Tests inject this directly;
   * production reads `REVIEW_AGENT_FEEDBACK_ALLOWLIST` (CSV) when
   * unset.
   */
  readonly allowlistEnv?: string;
};

/**
 * Check whether the CodeCommit caller's IAM principal is on the
 * operator-managed allowlist. Fail-closed: empty / unset
 * `REVIEW_AGENT_FEEDBACK_ALLOWLIST` denies all `/feedback` regardless
 * of the principal so a fresh deploy never accepts unsigned writes by
 * accident.
 *
 * Introduced in v1.2 #95 for the live webhook gate; v1.2 #113
 * extended its use to the disaster-recovery CLI
 * (`review-agent recover feedback-history --platform codecommit`)
 * so the recovery walk applies the exact same authz check the live
 * receiver does.
 *
 * The env value is a comma-separated list of full IAM principal
 * ARNs / IDs. Whitespace around each entry is trimmed.
 */
export function checkCodeCommitFeedbackAuthz(input: CodeCommitAuthzInput): FeedbackAuthzResult {
  const raw =
    input.allowlistEnv !== undefined
      ? input.allowlistEnv
      : typeof process !== 'undefined'
        ? process.env.REVIEW_AGENT_FEEDBACK_ALLOWLIST
        : undefined;
  const allowlist = parseAllowlist(raw);
  if (allowlist.length === 0) {
    return {
      allowed: false,
      reason: 'REVIEW_AGENT_FEEDBACK_ALLOWLIST is unset; CodeCommit /feedback fail-closed',
    };
  }
  if (!input.principalId || input.principalId.length === 0) {
    return { allowed: false, reason: 'missing principalId on CodeCommit feedback event' };
  }
  if (allowlist.includes(input.principalId)) {
    return { allowed: true };
  }
  return {
    allowed: false,
    reason: `principal '${input.principalId}' is not on REVIEW_AGENT_FEEDBACK_ALLOWLIST`,
  };
}

function parseAllowlist(raw: string | undefined): ReadonlyArray<string> {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
