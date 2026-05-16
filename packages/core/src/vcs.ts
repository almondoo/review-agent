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
};

export type GetDiffOpts = {
  readonly sinceSha?: string;
};

export type VCS = {
  readonly platform: 'github' | 'codecommit';
  getPR(ref: PRRef): Promise<PR>;
  getDiff(ref: PRRef, opts?: GetDiffOpts): Promise<Diff>;
  getFile(ref: PRRef, path: string, sha: string): Promise<Buffer>;
  cloneRepo(ref: PRRef, dir: string, opts: CloneOpts): Promise<void>;
  postReview(ref: PRRef, review: ReviewPayload): Promise<void>;
  postSummary(ref: PRRef, body: string): Promise<{ commentId: string }>;
  getExistingComments(ref: PRRef): Promise<ReadonlyArray<ExistingComment>>;
  getStateComment(ref: PRRef): Promise<ReviewState | null>;
  upsertStateComment(ref: PRRef, state: ReviewState): Promise<void>;
};
