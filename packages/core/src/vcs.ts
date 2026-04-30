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
  readonly destination: string;
  readonly depth?: number;
  readonly partial?: boolean;
  readonly sparsePaths?: ReadonlyArray<string>;
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

export type PostInlineCommentInput = {
  readonly path: string;
  readonly line: number;
  readonly side: 'LEFT' | 'RIGHT';
  readonly body: string;
};

export type VCS = {
  readonly platform: 'github' | 'codecommit';
  getPR(ref: PRRef): Promise<PR>;
  getDiff(ref: PRRef): Promise<Diff>;
  clone(ref: PRRef, opts: CloneOpts): Promise<void>;
  listExistingComments(ref: PRRef): Promise<ReadonlyArray<ExistingComment>>;
  postInlineComment(ref: PRRef, input: PostInlineCommentInput): Promise<void>;
  postSummaryComment(ref: PRRef, body: string): Promise<void>;
  upsertHiddenStateComment(ref: PRRef, body: string): Promise<void>;
  readHiddenStateComment(ref: PRRef): Promise<string | null>;
};
