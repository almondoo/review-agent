/**
 * `/feedback` permission guard — v1.2 #95.
 *
 * `/feedback accept|reject|dismiss` writes into `review_history`,
 * which the agent re-reads on subsequent reviews as
 * `<learned_facts>`. An attacker who can drop comments on a PR but
 * cannot push to the repo therefore has a low-cost path to poison
 * future review outputs unless we gate the command on **write
 * permission** to the repository.
 *
 * Two transports are supported:
 *
 *   - **GitHub** — `repos.getCollaboratorPermissionLevel` returns one
 *     of `admin / maintain / write / triage / read / none`. Only the
 *     first three constitute "push" access; the rest are denied.
 *
 *   - **CodeCommit** — there is no equivalent REST endpoint, so we
 *     start with an operator-managed CSV allowlist in
 *     `REVIEW_AGENT_FEEDBACK_ALLOWLIST`. The receiver matches the
 *     SNS event's `userIdentity.principalId` (or another
 *     adapter-provided principal id) against the allowlist. Fail
 *     closed: empty / unset allowlist denies every `/feedback`.
 *
 * Denied requests are **silently ignored** by the caller — surfacing
 * a public rejection comment would create a comment-forward DoS vector
 * (anyone could trigger an automated reply on every PR by spamming
 * `/feedback`).
 *
 * The reason string returned alongside `allowed: false` is for
 * structured logs only — never put it back on the PR.
 */

export {
  type CodeCommitAuthzInput,
  checkCodeCommitFeedbackAuthz,
  type FeedbackAuthzResult,
} from '@review-agent/platform-codecommit';

import type { FeedbackAuthzResult } from '@review-agent/platform-codecommit';

/**
 * Minimal Octokit shape so the server package does not need to
 * depend on `@octokit/rest` directly. The platform-github adapter
 * already wraps the real client; tests inject a stub.
 */
export type CollaboratorPermissionGetter = (args: {
  readonly owner: string;
  readonly repo: string;
  readonly username: string;
}) => Promise<{ readonly data: { readonly permission?: string } }>;

export type GithubAuthzInput = {
  readonly octokit: {
    readonly rest: {
      readonly repos: {
        readonly getCollaboratorPermissionLevel: CollaboratorPermissionGetter;
      };
    };
  };
  readonly owner: string;
  readonly repo: string;
  readonly username: string;
};

const GITHUB_WRITE_PERMISSIONS: ReadonlySet<string> = new Set(['admin', 'maintain', 'write']);

/**
 * Check whether the GitHub user has write-equivalent permission on
 * the repo. The function never throws — `getCollaboratorPermissionLevel`
 * errors (network failure, 403, etc.) resolve to `allowed: false` so
 * the caller's failure-mode is "ignore the command" rather than "crash
 * the worker on a transient API hiccup".
 */
export async function checkGithubFeedbackAuthz(
  input: GithubAuthzInput,
): Promise<FeedbackAuthzResult> {
  if (!input.username || input.username.length === 0) {
    return { allowed: false, reason: 'missing username on webhook payload' };
  }
  try {
    const res = await input.octokit.rest.repos.getCollaboratorPermissionLevel({
      owner: input.owner,
      repo: input.repo,
      username: input.username,
    });
    const permission = res.data.permission;
    if (typeof permission !== 'string') {
      return { allowed: false, reason: 'getCollaboratorPermissionLevel returned no permission' };
    }
    if (GITHUB_WRITE_PERMISSIONS.has(permission)) {
      return { allowed: true };
    }
    return { allowed: false, reason: `permission '${permission}' is below write` };
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'unknown';
    return { allowed: false, reason: `getCollaboratorPermissionLevel threw: ${msg}` };
  }
}
