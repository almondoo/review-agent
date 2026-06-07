import type { ReviewPayload, ReviewState } from './review.js';

export type PRRef = {
  readonly platform: 'github' | 'codecommit';
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
};

export type PR = {
  readonly ref: PRRef;
  readonly title: string;
  readonly body: string;
  readonly author: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly baseRef: string;
  readonly headRef: string;
  readonly draft: boolean;
  readonly labels: ReadonlyArray<string>;
  /**
   * Latest commit messages on the PR head, oldest → newest. Surfaced
   * to the LLM via `<commits>` in the `<untrusted>` wrapper so it
   * can read author intent across a multi-commit PR. Adapters MUST
   * cap the list (head-N latest commits, each ≤ N KB) to bound
   * prompt cost on rebased PRs with hundreds of commits.
   * Empty array when the platform does not expose commit listings.
   */
  readonly commitMessages: ReadonlyArray<{ readonly sha: string; readonly message: string }>;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type DiffFile = {
  readonly path: string;
  readonly previousPath: string | null;
  readonly status: 'added' | 'modified' | 'removed' | 'renamed';
  readonly additions: number;
  readonly deletions: number;
  readonly patch: string | null;
};

export type Diff = {
  readonly baseSha: string;
  readonly headSha: string;
  readonly files: ReadonlyArray<DiffFile>;
};

export type CloneOpts = {
  readonly depth?: number;
  readonly filter?: 'blob:none' | 'tree:0' | 'none';
  readonly sparsePaths?: ReadonlyArray<string>;
  readonly submodules?: boolean;
  readonly lfs?: boolean;
};

export type ExistingComment = {
  readonly id: string | number;
  readonly path: string | null;
  readonly line: number | null;
  readonly side: 'LEFT' | 'RIGHT' | null;
  readonly body: string;
  readonly author: string;
  readonly createdAt: string;
  /**
   * v1.2 #110: parent comment id if the comment is a reply.
   * CodeCommit threads `/feedback` replies via `inReplyTo`; GitHub
   * exposes the same on `pull_request_review_comment.in_reply_to_id`.
   * Optional because not every comment is a reply. CodeCommit
   * recovery walks a `/feedback` reply back to its parent Bot
   * comment (carrying the fingerprint marker — #96) via this field.
   */
  readonly inReplyTo?: string;
};

export type GetDiffOpts = {
  readonly sinceSha?: string;
};

/**
 * Static, per-adapter declaration of what the underlying VCS platform
 * actually supports. Callers branch on capabilities instead of
 * try/catch-ing platform-specific failure (cloneRepo throw on
 * CodeCommit, getStateComment returning null on CodeCommit, etc.) so
 * the contract is visible at the type level.
 *
 * Fields are intentionally narrow literal unions rather than booleans
 * where the platform offers multiple modes (e.g. `stateComment` is
 * `'native' | 'postgres-only'` rather than a flag) so future adapters
 * cannot silently degrade to "false means broken" semantics.
 */
export type VcsCapabilities = {
  /** `cloneRepo` can succeed. False on CodeCommit (no working-tree path; the runner uses getDiff()+getFile()). */
  readonly clone: boolean;
  /**
   * How `getStateComment` / `upsertStateComment` behave:
   *
   * - `'native'`     — the platform persists the hidden HTML marker; the comment is canonical (GitHub).
   * - `'postgres-only'` — the adapter is inert and the Postgres mirror is canonical (CodeCommit; spec §12.1.1).
   */
  readonly stateComment: 'native' | 'postgres-only';
  /**
   * How `review.event` (APPROVE / REQUEST_CHANGES) maps onto the platform:
   *
   * - `'github'`     — `pulls.createReview({event})` carries the verdict natively.
   * - `'codecommit'` — `UpdatePullRequestApprovalState` is the target (gated by `codecommit.approvalState` opt-in; see #74).
   * - `'none'`       — the adapter drops the field; operators must enforce merge-blocking out of band.
   */
  readonly approvalEvent: 'github' | 'codecommit' | 'none';
  /** `pr.commitMessages` is populated. False on CodeCommit (no per-PR commit-listing API). */
  readonly commitMessages: boolean;
  /**
   * Whether the adapter supports posting a threaded reply to an existing
   * inline review comment (#149 conversational replies).
   *
   * - `true`  — `postReply` will call the platform's reply-to-comment API
   *             (GitHub: `pulls.createReplyForReviewComment`).
   * - `false` — `postReply` is a no-op; the platform does not have a
   *             native thread-reply mechanism (CodeCommit). Callers should
   *             guard on this capability before invoking `postReply`.
   */
  readonly conversationReply: boolean;
  /**
   * Whether the adapter renders `InlineComment.suggestion` as a native
   * committable suggestion block (#152).
   *
   * - `true`  — GitHub: renders suggestions as ```suggestion fenced blocks
   *             inside the review comment. GitHub UI shows an "Apply suggestion"
   *             button. Validity is gated by the adapter on hunk membership
   *             (suggestions outside the diff hunk are suppressed to a plain
   *             comment body).
   * - `false` — CodeCommit (and other adapters without native suggestion
   *             syntax): the suggestion is rendered as an informational
   *             fenced code block (`**Suggested fix:** ...`) in the comment
   *             body. No commit button is available. No hunk check is needed
   *             because the block is purely informational.
   */
  readonly committableSuggestions: boolean;
};

/**
 * Read-only PR introspection surface. Tools that only need to inspect a
 * PR (recover-sync-state's hidden-comment reader, dedup readers, etc.)
 * depend on this narrower type instead of the full {@link VCS}.
 */
export type VcsReader = {
  getPR(ref: PRRef): Promise<PR>;
  getDiff(ref: PRRef, opts?: GetDiffOpts): Promise<Diff>;
  getFile(ref: PRRef, path: string, sha: string): Promise<Buffer>;
  cloneRepo(ref: PRRef, dir: string, opts: CloneOpts): Promise<void>;
  getExistingComments(ref: PRRef): Promise<ReadonlyArray<ExistingComment>>;
};

/**
 * Write surface: post the review (inline comments + event), the
 * summary comment, and threaded inline-comment replies (#149).
 * Separated so tests can stub posts without implementing reads.
 */
export type VcsWriter = {
  postReview(ref: PRRef, review: ReviewPayload): Promise<void>;
  postSummary(ref: PRRef, body: string): Promise<{ commentId: string }>;
  /**
   * Post a reply into an existing inline review comment thread (#149).
   *
   * `commentId` is the id of the root comment the user is replying to
   * (GitHub: `pull_request_review_comment.id`). The body is posted as a
   * child reply in the same thread.
   *
   * Adapters that do not support threaded replies (CodeCommit) advertise
   * `capabilities.conversationReply = false` and may return immediately
   * without any API call. Callers SHOULD check the capability flag before
   * invoking this method to avoid silent no-ops.
   */
  postReply(ref: PRRef, commentId: string | number, body: string): Promise<void>;
};

/**
 * State-mirror surface: read/write the canonical hidden-state comment
 * (GitHub) or no-op (CodeCommit, where Postgres is canonical). Recover
 * commands depend on this narrowly so they don't pull in clone or
 * review-post surface area.
 */
export type VcsStateStore = {
  getStateComment(ref: PRRef): Promise<ReviewState | null>;
  upsertStateComment(ref: PRRef, state: ReviewState): Promise<void>;
};

export type VCS = {
  readonly platform: 'github' | 'codecommit';
  readonly capabilities: VcsCapabilities;
} & VcsReader &
  VcsWriter &
  VcsStateStore;
