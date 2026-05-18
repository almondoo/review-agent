import type { Octokit } from '@octokit/rest';

/**
 * Reaction reads + review-dismissal helpers used by the v1.2 epic
 * #83 Phase 3 (#92) feedback flow. The webhook payload already
 * carries the data for `reaction.created` and
 * `pull_request_review.dismissed` events, so these helpers are
 * mainly for **operator polling / backfill** paths (e.g. nightly
 * sweeps that pick up reactions the webhook may have missed during
 * a queue outage).
 *
 * The functions live outside the `VCS` interface because the
 * feedback flow is platform-specific (CodeCommit has no reaction
 * concept) and only the GitHub server-mode handler invokes them.
 */

const REACTION_KIND_MAP: Record<string, 'thumbs_up' | 'thumbs_down' | null> = {
  '+1': 'thumbs_up',
  '-1': 'thumbs_down',
  // Everything else (`laugh`, `confused`, `heart`, `hooray`,
  // `rocket`, `eyes`) is noise per spec §7.6 "explicit signals
  // only". Map to null so callers explicitly drop them.
  laugh: null,
  confused: null,
  heart: null,
  hooray: null,
  rocket: null,
  eyes: null,
};

export type ListReactionsArgs = {
  readonly owner: string;
  readonly repo: string;
  readonly commentId: number;
};

export type FeedbackSignalRow = {
  readonly kind: 'thumbs_up' | 'thumbs_down';
  readonly userLogin: string;
  readonly createdAt: string;
};

/**
 * List reactions on a PR review comment and return only the
 * `+1` / `-1` rows mapped to `FeedbackKind`. Use this when
 * back-filling from a known commentId (e.g. recovery from a
 * webhook outage) — the live receive path already classifies
 * reactions via `handleWebhook`.
 */
export async function listReviewCommentReactions(
  octokit: Octokit,
  args: ListReactionsArgs,
): Promise<ReadonlyArray<FeedbackSignalRow>> {
  const { data } = await octokit.rest.reactions.listForPullRequestReviewComment({
    owner: args.owner,
    repo: args.repo,
    comment_id: args.commentId,
    per_page: 100,
  });
  return data
    .map((r) => {
      const kind = REACTION_KIND_MAP[r.content];
      if (!kind) return null;
      return {
        kind,
        userLogin: r.user?.login ?? 'unknown',
        createdAt: r.created_at,
      };
    })
    .filter((r): r is FeedbackSignalRow => r !== null);
}

export type GetReviewArgs = {
  readonly owner: string;
  readonly repo: string;
  readonly pullNumber: number;
  readonly reviewId: number;
};

/**
 * Fetch a PR review to inspect its `state` (e.g.
 * `'dismissed'`). The live receiver uses the webhook payload's
 * `action: 'dismissed'` directly; this helper exists for polling
 * paths.
 */
export async function getReviewState(
  octokit: Octokit,
  args: GetReviewArgs,
): Promise<{ readonly state: string }> {
  const { data } = await octokit.rest.pulls.getReview({
    owner: args.owner,
    repo: args.repo,
    pull_number: args.pullNumber,
    review_id: args.reviewId,
  });
  return { state: data.state };
}
