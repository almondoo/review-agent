import { Buffer } from 'node:buffer';
import {
  CodeCommitClient,
  type CodeCommitClientConfig,
  type Comment,
  type CommentsForPullRequest,
  type Difference,
  GetCommentsForPullRequestCommand,
  GetDifferencesCommand,
  GetFileCommand,
  GetPullRequestCommand,
  PostCommentForPullRequestCommand,
  type PullRequest,
} from '@aws-sdk/client-codecommit';
import type {
  CloneOpts,
  Diff,
  DiffFile,
  ExistingComment,
  GetDiffOpts,
  PR,
  PRRef,
  ReviewPayload,
  ReviewState,
  VCS,
} from '@review-agent/core';

// CodeCommit identifies a PR by a string `pullRequestId` that is a positive
// integer rendered as a string. Our shared PRRef carries `number`, so we
// stringify on the way in and surface the original id back via the PR.
function ensureCodeCommit(ref: PRRef): void {
  if (ref.platform !== 'codecommit') {
    throw new Error(`CodeCommit VCS adapter received platform='${ref.platform}'`);
  }
}

function toPullRequestId(ref: PRRef): string {
  return String(ref.number);
}

const CHANGE_TYPE_MAP: Readonly<Record<string, DiffFile['status']>> = {
  A: 'added',
  M: 'modified',
  D: 'removed',
};

function mapDiffStatus(changeType: string | undefined): DiffFile['status'] {
  if (!changeType) return 'modified';
  return CHANGE_TYPE_MAP[changeType] ?? 'modified';
}

export type CodeCommitClientLike = Pick<CodeCommitClient, 'send'>;

export type CodeCommitVCSOptions = {
  /** Override the SDK client. Defaults to a client built from env / SDK chain. */
  readonly client?: CodeCommitClientLike;
  /** Optional client config when not supplying a custom `client`. */
  readonly clientConfig?: CodeCommitClientConfig;
};

export function createCodecommitVCS(opts: CodeCommitVCSOptions = {}): VCS {
  const client =
    opts.client ?? (new CodeCommitClient(opts.clientConfig ?? {}) as CodeCommitClientLike);

  const getPR = async (ref: PRRef): Promise<PR> => {
    ensureCodeCommit(ref);
    const out = await client.send(
      new GetPullRequestCommand({ pullRequestId: toPullRequestId(ref) }),
    );
    const pr: PullRequest | undefined = out.pullRequest;
    if (!pr) throw new Error(`PR ${ref.number} not found in CodeCommit repo ${ref.repo}`);
    const target = pr.pullRequestTargets?.[0];
    return {
      ref,
      title: pr.title ?? '',
      body: pr.description ?? '',
      author: parseAuthor(pr.authorArn),
      baseSha: target?.destinationCommit ?? '',
      headSha: target?.sourceCommit ?? '',
      baseRef: target?.destinationReference ?? '',
      headRef: target?.sourceReference ?? '',
      draft: false,
      labels: [],
      createdAt: pr.creationDate?.toISOString() ?? new Date(0).toISOString(),
      updatedAt: pr.lastActivityDate?.toISOString() ?? new Date(0).toISOString(),
    };
  };

  const getDiff = async (ref: PRRef, deltaOpts: GetDiffOpts = {}): Promise<Diff> => {
    ensureCodeCommit(ref);
    const pr = await getPR(ref);
    const before = deltaOpts.sinceSha ?? pr.baseSha;
    const after = pr.headSha;
    const files: DiffFile[] = [];
    let nextToken: string | undefined;
    do {
      const out = await client.send(
        new GetDifferencesCommand({
          repositoryName: ref.repo,
          beforeCommitSpecifier: before,
          afterCommitSpecifier: after,
          NextToken: nextToken,
        }),
      );
      for (const d of out.differences ?? []) files.push(toDiffFile(d));
      nextToken = out.NextToken;
    } while (nextToken);
    return { baseSha: before, headSha: after, files };
  };

  const getFile = async (ref: PRRef, path: string, sha: string): Promise<Buffer> => {
    ensureCodeCommit(ref);
    const out = await client.send(
      new GetFileCommand({
        repositoryName: ref.repo,
        commitSpecifier: sha,
        filePath: path,
      }),
    );
    if (!out.fileContent) return Buffer.alloc(0);
    return Buffer.from(out.fileContent);
  };

  // CodeCommit clones use git over HTTPS with the AWS credential helper.
  // The runner does not currently shell out to git for CodeCommit because
  // diffs come from GetDifferences and file content from GetFile; expose
  // the limit explicitly rather than half-implementing it.
  const cloneRepo = async (_ref: PRRef, _dir: string, _opts: CloneOpts): Promise<void> => {
    throw new Error(
      'CodeCommit clone is not supported by this adapter; use getDiff() + getFile() instead.',
    );
  };

  const postReview = async (ref: PRRef, review: ReviewPayload): Promise<void> => {
    ensureCodeCommit(ref);
    const pr = await getPR(ref);
    if (review.summary) {
      await client.send(
        new PostCommentForPullRequestCommand({
          pullRequestId: toPullRequestId(ref),
          repositoryName: ref.repo,
          beforeCommitId: pr.baseSha,
          afterCommitId: pr.headSha,
          content: review.summary,
        }),
      );
    }
    for (const c of review.comments) {
      await client.send(
        new PostCommentForPullRequestCommand({
          pullRequestId: toPullRequestId(ref),
          repositoryName: ref.repo,
          beforeCommitId: pr.baseSha,
          afterCommitId: pr.headSha,
          location: {
            filePath: c.path,
            filePosition: c.line,
            relativeFileVersion: c.side === 'LEFT' ? 'BEFORE' : 'AFTER',
          },
          content: c.body,
        }),
      );
    }
  };

  const postSummary = async (ref: PRRef, body: string): Promise<{ commentId: string }> => {
    ensureCodeCommit(ref);
    const pr = await getPR(ref);
    const out = await client.send(
      new PostCommentForPullRequestCommand({
        pullRequestId: toPullRequestId(ref),
        repositoryName: ref.repo,
        beforeCommitId: pr.baseSha,
        afterCommitId: pr.headSha,
        content: body,
      }),
    );
    return { commentId: out.comment?.commentId ?? '' };
  };

  const getExistingComments = async (ref: PRRef): Promise<ReadonlyArray<ExistingComment>> => {
    ensureCodeCommit(ref);
    const out: ExistingComment[] = [];
    let nextToken: string | undefined;
    do {
      const resp = await client.send(
        new GetCommentsForPullRequestCommand({
          pullRequestId: toPullRequestId(ref),
          repositoryName: ref.repo,
          nextToken,
        }),
      );
      for (const group of resp.commentsForPullRequestData ?? []) {
        for (const c of group.comments ?? []) {
          out.push(toExistingComment(group, c));
        }
      }
      nextToken = resp.nextToken;
    } while (nextToken);
    return out;
  };

  // CodeCommit does not preserve the GitHub-style hidden-state HTML
  // comment marker (§12.1.1). State is canonical in Postgres only — the
  // runner's review-state-mirror is the authoritative store, so this
  // adapter advertises that explicitly by returning null / no-op.
  const getStateComment = async (_ref: PRRef): Promise<ReviewState | null> => null;
  const upsertStateComment = async (_ref: PRRef, _state: ReviewState): Promise<void> => undefined;

  return {
    platform: 'codecommit',
    getPR,
    getDiff,
    getFile,
    cloneRepo,
    postReview,
    postSummary,
    getExistingComments,
    getStateComment,
    upsertStateComment,
  };
}

function toDiffFile(d: Difference): DiffFile {
  const path = d.afterBlob?.path ?? d.beforeBlob?.path ?? '';
  const status = mapDiffStatus(d.changeType);
  return {
    path,
    previousPath: status === 'renamed' ? (d.beforeBlob?.path ?? null) : null,
    status,
    additions: 0,
    deletions: 0,
    patch: null,
  };
}

function toExistingComment(group: CommentsForPullRequest, c: Comment): ExistingComment {
  const side = group.location?.relativeFileVersion;
  const sideMapped: ExistingComment['side'] =
    side === 'BEFORE' ? 'LEFT' : side === 'AFTER' ? 'RIGHT' : null;
  return {
    id: c.commentId ?? '',
    path: group.location?.filePath ?? null,
    line: group.location?.filePosition ?? null,
    side: sideMapped,
    body: c.content ?? '',
    author: parseAuthor(c.authorArn),
    createdAt: c.creationDate?.toISOString() ?? new Date(0).toISOString(),
  };
}

function parseAuthor(arn: string | undefined): string {
  if (!arn) return 'unknown';
  // arn:aws:iam::123456789012:user/jane → jane
  // arn:aws:sts::123456789012:assumed-role/role/session → assumed-role/role/session
  const parts = arn.split('/');
  return parts[parts.length - 1] ?? arn;
}
