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
  VcsCapabilities,
} from '@review-agent/core';

/**
 * Static capability declaration for GitHub — every flag is on. Kept
 * here next to the adapter so the adapter and its capability claims
 * stay in sync; deviations (e.g. a future GitHub Enterprise Server
 * variant that drops a feature) should override at construction time.
 */
export const GITHUB_CAPABILITIES: VcsCapabilities = {
  clone: true,
  stateComment: 'native',
  approvalEvent: 'github',
  commitMessages: true,
};

import { cloneWithStrategy, defaultRunGit, type RunGit } from './clone.js';
import { assertSafeRelativePath } from './path-guard.js';
import {
  buildSummaryWithState,
  formatStateComment,
  parseStateComment,
  type StateParseEventHandler,
} from './state-comment.js';

const STATUS_MAP: Readonly<Record<string, DiffFile['status']>> = {
  added: 'added',
  modified: 'modified',
  removed: 'removed',
  renamed: 'renamed',
  copied: 'modified',
  changed: 'modified',
  unchanged: 'modified',
};

/**
 * Cap on the number of recent commits surfaced to the LLM via
 * `PR.commitMessages`. A multi-author rebased PR can land with
 * hundreds of commits; sending all of them blows the prompt cache
 * and burns tokens with little marginal signal. 20 covers the
 * typical PR while keeping the upper-bound payload bounded.
 */
const COMMIT_MESSAGES_CAP = 20;

/**
 * Per-message byte cap. A 5 KB upper bound is generous for a
 * commit message but firm enough to truncate the occasional
 * pasted-stack-trace or AI-generated essay that some teams use
 * as their commit body.
 */
const COMMIT_MESSAGE_MAX_CHARS = 5_000;

function truncateMessage(message: string): string {
  if (message.length <= COMMIT_MESSAGE_MAX_CHARS) return message;
  return `${message.slice(0, COMMIT_MESSAGE_MAX_CHARS)}\n[...truncated at ${COMMIT_MESSAGE_MAX_CHARS} chars]`;
}

export type GithubVCSOptions = {
  readonly token: string;
  readonly octokit?: Pick<Octokit, 'rest' | 'paginate'>;
  readonly runGit?: RunGit;
  readonly cloneUrl?: (ref: PRRef) => string;
  /**
   * Invoked when the embedded state-comment JSON cannot be trusted
   * (`schema_mismatch`, `validation_failure`, `json_parse_failure`).
   * Callers should log + (for schema mismatches) append an
   * `state_schema_mismatch` audit event. When omitted, untrusted
   * state is silently dropped — i.e. the review is treated as fresh.
   */
  readonly onStateParseEvent?: StateParseEventHandler;
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
    // We only need the last `COMMIT_MESSAGES_CAP` commits. Fetch a
    // single page at the tail instead of paginating the whole PR —
    // a 1000-commit rebase otherwise burns 10× the rate-limit budget
    // and 5–15 s of latency on every review (reviewer I-1).
    //
    // GitHub's `listCommits` returns oldest→newest; the newest are on
    // the highest-numbered page. With `per_page=100` (Octokit's max)
    // and `page=ceil(total/100)`, one request covers the tail in the
    // vast majority of PRs (total ≤ 100 is page 1; total > 100 with a
    // full last page is also one request). The remaining pathological
    // case is `total > 100` with a *partial* last page (e.g. 101
    // commits → page 2 has 1 commit). In that case we also fetch the
    // penultimate page to fill out the `COMMIT_MESSAGES_CAP` window —
    // at most 2 API calls total, regardless of PR size.
    const COMMIT_PAGE_SIZE = 100;
    // Defensive `?? 0`: Octokit's openapi-types declares
    // `commits: number` required, but mocks in our own test suite
    // and third-party API proxies sometimes elide the field. A
    // missing value collapses to "no commits to fetch" rather than
    // a NaN page number — and we skip the listCommits call entirely
    // (no point firing a request we know will return nothing useful).
    const totalCommits = data.commits ?? 0;
    let commitsRaw: ReadonlyArray<{
      readonly sha: string;
      readonly commit: { readonly message?: string };
    }> = [];
    if (totalCommits > 0) {
      const lastPage = Math.max(1, Math.ceil(totalCommits / COMMIT_PAGE_SIZE));
      const lastResp = await octokit.rest.pulls.listCommits({
        owner: ref.owner,
        repo: ref.repo,
        pull_number: ref.number,
        per_page: COMMIT_PAGE_SIZE,
        page: lastPage,
      });
      commitsRaw = lastResp.data;
      if (lastPage > 1 && commitsRaw.length < COMMIT_MESSAGES_CAP) {
        const prevResp = await octokit.rest.pulls.listCommits({
          owner: ref.owner,
          repo: ref.repo,
          pull_number: ref.number,
          per_page: COMMIT_PAGE_SIZE,
          page: lastPage - 1,
        });
        commitsRaw = [...prevResp.data, ...commitsRaw];
      }
    }
    const commitMessages = commitsRaw.slice(-COMMIT_MESSAGES_CAP).map((c) => ({
      sha: c.sha,
      message: truncateMessage(c.commit.message ?? ''),
    }));
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
      commitMessages,
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
    // `event` is optional on ReviewPayload so callers that haven't
    // been updated (or third-party adapters via the VCS interface)
    // still get the v0.1 `COMMENT` behavior. Wiring the runner
    // through computeReviewEvent is what unlocks `REQUEST_CHANGES`
    // on critical findings.
    const event = review.event ?? 'COMMENT';
    await octokit.rest.pulls.createReview({
      owner: ref.owner,
      repo: ref.repo,
      pull_number: ref.number,
      event,
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
    return parseStateComment(found.body, opts.onStateParseEvent);
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
    capabilities: GITHUB_CAPABILITIES,
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
