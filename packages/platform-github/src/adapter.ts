import { Buffer } from 'node:buffer';
import { Octokit } from '@octokit/rest';
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
import { cloneWithStrategy, defaultRunGit, type RunGit } from './clone.js';
import { assertSafeRelativePath } from './path-guard.js';
import { buildSummaryWithState, formatStateComment, parseStateComment } from './state-comment.js';

const STATUS_MAP: Readonly<Record<string, DiffFile['status']>> = {
  added: 'added',
  modified: 'modified',
  removed: 'removed',
  renamed: 'renamed',
  copied: 'modified',
  changed: 'modified',
  unchanged: 'modified',
};

export type GithubVCSOptions = {
  readonly token: string;
  readonly octokit?: Pick<Octokit, 'rest' | 'paginate'>;
  readonly runGit?: RunGit;
  readonly cloneUrl?: (ref: PRRef) => string;
};

function mapStatus(status: string | undefined): DiffFile['status'] {
  if (!status) return 'modified';
  return STATUS_MAP[status] ?? 'modified';
}

function ensureGithub(ref: PRRef): void {
  if (ref.platform !== 'github') {
    throw new Error(`Github VCS adapter received platform='${ref.platform}'`);
  }
}

function defaultCloneUrl(ref: PRRef, token: string): string {
  return `https://x-access-token:${token}@github.com/${ref.owner}/${ref.repo}.git`;
}

export function createGithubVCS(opts: GithubVCSOptions): VCS {
  if (!opts.token) {
    throw new Error(
      'createGithubVCS requires a token (Action: GITHUB_TOKEN; CLI: REVIEW_AGENT_GH_TOKEN)',
    );
  }
  const octokit = opts.octokit ?? new Octokit({ auth: opts.token });
  const runGit = opts.runGit ?? defaultRunGit;
  const cloneUrl = opts.cloneUrl ?? ((ref) => defaultCloneUrl(ref, opts.token));

  const getPR = async (ref: PRRef): Promise<PR> => {
    ensureGithub(ref);
    const { data } = await octokit.rest.pulls.get({
      owner: ref.owner,
      repo: ref.repo,
      pull_number: ref.number,
    });
    return {
      ref,
      title: data.title,
      body: data.body ?? '',
      author: data.user?.login ?? 'unknown',
      baseSha: data.base.sha,
      headSha: data.head.sha,
      baseRef: data.base.ref,
      headRef: data.head.ref,
      draft: data.draft ?? false,
      labels: data.labels.map((l) => (typeof l === 'string' ? l : (l.name ?? ''))),
      createdAt: data.created_at,
      updatedAt: data.updated_at,
    };
  };

  const getDiff = async (ref: PRRef, diffOpts: GetDiffOpts = {}): Promise<Diff> => {
    ensureGithub(ref);
    if (diffOpts.sinceSha) {
      const { data } = await octokit.rest.repos.compareCommitsWithBasehead({
        owner: ref.owner,
        repo: ref.repo,
        basehead: `${diffOpts.sinceSha}...HEAD`,
      });
      return {
        baseSha: data.merge_base_commit.sha,
        headSha: data.commits[data.commits.length - 1]?.sha ?? diffOpts.sinceSha,
        files: (data.files ?? []).map(
          (f): DiffFile => ({
            path: f.filename,
            previousPath: f.previous_filename ?? null,
            status: mapStatus(f.status),
            additions: f.additions,
            deletions: f.deletions,
            patch: f.patch ?? null,
          }),
        ),
      };
    }

    const pr = await getPR(ref);
    const files = await octokit.paginate(octokit.rest.pulls.listFiles, {
      owner: ref.owner,
      repo: ref.repo,
      pull_number: ref.number,
      per_page: 100,
    });
    return {
      baseSha: pr.baseSha,
      headSha: pr.headSha,
      files: files.map(
        (f): DiffFile => ({
          path: f.filename,
          previousPath: f.previous_filename ?? null,
          status: mapStatus(f.status),
          additions: f.additions,
          deletions: f.deletions,
          patch: f.patch ?? null,
        }),
      ),
    };
  };

  const getFile = async (ref: PRRef, path: string, sha: string): Promise<Buffer> => {
    ensureGithub(ref);
    assertSafeRelativePath(path);
    const { data } = await octokit.rest.repos.getContent({
      owner: ref.owner,
      repo: ref.repo,
      path,
      ref: sha,
    });
    if (Array.isArray(data) || data.type !== 'file' || typeof data.content !== 'string') {
      throw new Error(`Cannot read non-file content at '${path}'`);
    }
    return Buffer.from(data.content, data.encoding === 'base64' ? 'base64' : 'utf-8');
  };

  const cloneRepo = async (ref: PRRef, dir: string, cloneOpts: CloneOpts): Promise<void> => {
    ensureGithub(ref);
    const url = cloneUrl(ref);
    const pr = await getPR(ref);
    await cloneWithStrategy(url, dir, ref, pr.headSha, cloneOpts, runGit);
  };

  const postReview = async (ref: PRRef, review: ReviewPayload): Promise<void> => {
    ensureGithub(ref);
    const summaryWithState = buildSummaryWithState(review.summary, review.state);
    const comments = review.comments.map((c) => ({
      path: c.path,
      line: c.line,
      side: c.side,
      body: c.body,
    }));
    await octokit.rest.pulls.createReview({
      owner: ref.owner,
      repo: ref.repo,
      pull_number: ref.number,
      event: 'COMMENT',
      body: summaryWithState,
      comments,
    });
  };

  const postSummary = async (ref: PRRef, body: string): Promise<{ commentId: string }> => {
    ensureGithub(ref);
    const { data } = await octokit.rest.issues.createComment({
      owner: ref.owner,
      repo: ref.repo,
      issue_number: ref.number,
      body,
    });
    return { commentId: String(data.id) };
  };

  const getExistingComments = async (ref: PRRef): Promise<ReadonlyArray<ExistingComment>> => {
    ensureGithub(ref);
    const review = await octokit.paginate(octokit.rest.pulls.listReviewComments, {
      owner: ref.owner,
      repo: ref.repo,
      pull_number: ref.number,
      per_page: 100,
    });
    return review.map(
      (c): ExistingComment => ({
        id: c.id,
        path: c.path ?? null,
        line: c.line ?? c.original_line ?? null,
        side: (c.side as 'LEFT' | 'RIGHT') ?? null,
        body: c.body ?? '',
        author: c.user?.login ?? 'unknown',
        createdAt: c.created_at,
      }),
    );
  };

  const findStateComment = async (ref: PRRef): Promise<{ id: number; body: string } | null> => {
    const items = await octokit.paginate(octokit.rest.issues.listComments, {
      owner: ref.owner,
      repo: ref.repo,
      issue_number: ref.number,
      per_page: 100,
    });
    for (let i = items.length - 1; i >= 0; i--) {
      const c = items[i];
      if (!c) continue;
      if (typeof c.body === 'string' && c.body.includes('<!-- review-agent-state:')) {
        return { id: c.id, body: c.body };
      }
    }
    return null;
  };

  const getStateComment = async (ref: PRRef): Promise<ReviewState | null> => {
    ensureGithub(ref);
    const found = await findStateComment(ref);
    if (!found) return null;
    return parseStateComment(found.body);
  };

  const upsertStateComment = async (ref: PRRef, state: ReviewState): Promise<void> => {
    ensureGithub(ref);
    const body = `${formatStateComment(state)}\n`;
    const found = await findStateComment(ref);
    if (found) {
      await octokit.rest.issues.updateComment({
        owner: ref.owner,
        repo: ref.repo,
        comment_id: found.id,
        body,
      });
      return;
    }
    await octokit.rest.issues.createComment({
      owner: ref.owner,
      repo: ref.repo,
      issue_number: ref.number,
      body,
    });
  };

  return {
    platform: 'github',
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
