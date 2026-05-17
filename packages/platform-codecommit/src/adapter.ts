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
  UpdatePullRequestApprovalStateCommand,
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
  VcsCapabilities,
} from '@review-agent/core';

/**
 * Static capability declaration for CodeCommit. Permanent design
 * decisions (spec §5.2.1, §12.1.1) — not gated on runtime config.
 *
 * - `clone: false`              — no working-tree path (cloneRepo throws).
 * - `stateComment: 'postgres-only'` — adapter is inert; Postgres canonical.
 * - `approvalEvent: 'codecommit'`   — `UpdatePullRequestApprovalState` is
 *   the supported target. Whether the adapter actually calls it on a
 *   given review is gated by the runtime opt-in
 *   `CodeCommitVCSOptions.approvalState: 'managed' | 'off'` (issue #74).
 *   `approvalEvent` advertises mapping availability, not opt-in state.
 * - `commitMessages: false`      — no per-PR commit-listing API; the
 *   adapter returns `pr.commitMessages = []`.
 */
export const CODECOMMIT_CAPABILITIES: VcsCapabilities = {
  clone: false,
  stateComment: 'postgres-only',
  approvalEvent: 'codecommit',
  commitMessages: false,
};

// CodeCommit identifies a PR by a string `pullRequestId` that is a positive
// integer rendered as a string. Our shared PRRef carries `number`, so we
// stringify on the way in and surface the original id back via the PR.
function ensureCodeCommit(ref: PRRef): void {
  if (ref.platform !== 'codecommit') {
    throw new Error(`CodeCommit VCS adapter received platform='${ref.platform}'`);
  }
}

const TRAVERSAL_REGEX = /(^|[/\\])\.\.([/\\]|$)/;

// Mirrors platform-github/path-guard.ts. Kept local rather than introducing a
// platform-platform dependency. CodeCommit's GetFile API takes an arbitrary
// `filePath` and does not by itself reject `..`, absolute paths, or NUL bytes.
export function assertSafeRelativePath(path: string): void {
  if (!path) throw new Error('Refusing empty path');
  if (path.startsWith('/')) throw new Error(`Refusing absolute path: '${path}'`);
  if (path.startsWith('~')) throw new Error(`Refusing home-expanded path: '${path}'`);
  if (TRAVERSAL_REGEX.test(path)) throw new Error(`Refusing traversal path: '${path}'`);
  if (path.includes('\0')) throw new Error('Refusing path with NUL byte');
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

/**
 * Operator opt-in for mapping `review.event` to CodeCommit's
 * `UpdatePullRequestApprovalState` API (issue #74). The capability is
 * advertised statically via {@link CODECOMMIT_CAPABILITIES.approvalEvent}
 * (`'codecommit'`) regardless of this flag — the flag only gates whether
 * the adapter actually issues the API call at `postReview` time.
 *
 * - `'off'` (default) — preserve the v0.2 behavior: `review.event` is
 *   ignored and no approval-state call is made. Operators without an
 *   approval rule applicable to the agent's IAM principal see no change.
 * - `'managed'`       — translate `review.event` as follows:
 *     - `APPROVE`         → `UpdatePullRequestApprovalState(APPROVE)`
 *     - `REQUEST_CHANGES` → `UpdatePullRequestApprovalState(REVOKE)`
 *     - `COMMENT`         → no-op (no approval-state call)
 *   When the SDK call fails (e.g. no approval rule targets the agent),
 *   the failure is logged via `console.warn` and the rest of `postReview`
 *   proceeds.
 */
export type CodecommitApprovalState = 'managed' | 'off';

export type CodeCommitVCSOptions = {
  /** Override the SDK client. Defaults to a client built from env / SDK chain. */
  readonly client?: CodeCommitClientLike;
  /** Optional client config when not supplying a custom `client`. */
  readonly clientConfig?: CodeCommitClientConfig;
  /**
   * Opt-in mapping of `review.event` to `UpdatePullRequestApprovalState`.
   * See {@link CodecommitApprovalState}. Defaults to `'off'` for
   * backward compatibility.
   */
  readonly approvalState?: CodecommitApprovalState;
};

export function createCodecommitVCS(opts: CodeCommitVCSOptions = {}): VCS {
  const client =
    opts.client ?? (new CodeCommitClient(opts.clientConfig ?? {}) as CodeCommitClientLike);
  const approvalStateMode: CodecommitApprovalState = opts.approvalState ?? 'off';

  const fetchCodeCommitPR = async (ref: PRRef): Promise<PullRequest> => {
    const out = await client.send(
      new GetPullRequestCommand({ pullRequestId: toPullRequestId(ref) }),
    );
    const pr: PullRequest | undefined = out.pullRequest;
    if (!pr) throw new Error(`PR ${ref.number} not found in CodeCommit repo ${ref.repo}`);
    return pr;
  };

  const toPR = (ref: PRRef, pr: PullRequest): PR => {
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
      // CodeCommit's PullRequest payload does not include commit
      // messages, and there is no listCommits-equivalent on the
      // pull request itself; we'd need GetCommit per sha after
      // walking the source-branch history, which is too expensive
      // to do unconditionally. Return empty for now; a follow-up
      // can wire GetCommit if operators ask for it.
      commitMessages: [],
      createdAt: pr.creationDate?.toISOString() ?? new Date(0).toISOString(),
      updatedAt: pr.lastActivityDate?.toISOString() ?? new Date(0).toISOString(),
    };
  };

  const getPR = async (ref: PRRef): Promise<PR> => {
    ensureCodeCommit(ref);
    const pr = await fetchCodeCommitPR(ref);
    return toPR(ref, pr);
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
    assertSafeRelativePath(path);
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
    // Fetch the raw SDK PullRequest once so we have both the
    // base/head commits (for comment posting) and the `revisionId`
    // required by `UpdatePullRequestApprovalState` (#74). The mapping
    // is gated behind the `approvalState: 'managed'` opt-in below;
    // see the option doc on `CodeCommitVCSOptions.approvalState`.
    const rawPr = await fetchCodeCommitPR(ref);
    const pr = toPR(ref, rawPr);
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
    await applyApprovalState(ref, rawPr, review);
  };

  const applyApprovalState = async (
    ref: PRRef,
    rawPr: PullRequest,
    review: ReviewPayload,
  ): Promise<void> => {
    if (approvalStateMode !== 'managed') return;
    const event = review.event;
    if (event !== 'APPROVE' && event !== 'REQUEST_CHANGES') return;
    const revisionId = rawPr.revisionId;
    if (!revisionId) {
      // biome-ignore lint/suspicious/noConsole: operator-visible degrade-non-fatal log line
      console.warn(
        `[platform-codecommit] skipping UpdatePullRequestApprovalState for PR ${ref.number}: ` +
          'no revisionId on PullRequest payload',
      );
      return;
    }
    const desired: 'APPROVE' | 'REVOKE' = event === 'APPROVE' ? 'APPROVE' : 'REVOKE';
    try {
      await client.send(
        new UpdatePullRequestApprovalStateCommand({
          pullRequestId: toPullRequestId(ref),
          revisionId,
          approvalState: desired,
        }),
      );
    } catch (err) {
      // Operators without an approval rule applicable to the agent's
      // IAM principal will get a typed SDK error here
      // (`ApprovalRuleDoesNotExistException`, `InvalidApprovalStateException`,
      // etc.). Degrade non-fatally — the inline comments above were
      // posted successfully, and the operator may not have wired an
      // approval rule yet.
      //
      // Log ONLY the SDK error class name. AWS SDK error `message`
      // strings frequently include the caller's role ARN and account
      // id (e.g. `User: arn:aws:sts::123456789012:assumed-role/X is
      // not authorized…`). Including `err.message` would leak that
      // tenancy info into whatever sink stdout flows to. The error
      // name alone is sufficient for operators to diagnose
      // (`ApprovalRuleDoesNotExistException`, `AccessDeniedException`,
      // …) without revealing IAM identity.
      const name = err instanceof Error ? err.name : 'unknown';
      // biome-ignore lint/suspicious/noConsole: operator-visible degrade-non-fatal log line
      console.warn(
        `[platform-codecommit] UpdatePullRequestApprovalState failed (${name}); ` +
          `the agent's IAM principal may have no applicable approval rule. ` +
          `Skipped approval-state mutation for PR ${toPullRequestId(ref)}.`,
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
    capabilities: CODECOMMIT_CAPABILITIES,
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
