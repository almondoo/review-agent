import type { PRRef, ReviewPayload, ReviewState } from '@review-agent/core';
import { describe, expect, it, vi } from 'vitest';
import { createGithubVCS } from './adapter.js';

const ref: PRRef = { platform: 'github', owner: 'o', repo: 'r', number: 7 };

const validState: ReviewState = {
  schemaVersion: 1,
  lastReviewedSha: '0123456789abcdef0123456789abcdef01234567',
  baseSha: 'fedcba9876543210fedcba9876543210fedcba98',
  reviewedAt: '2026-04-30T10:00:00.000Z',
  modelUsed: 'claude-sonnet-4-6',
  totalTokens: 100,
  totalCostUsd: 0.01,
  commentFingerprints: [],
};

function createMockOctokit(impl: {
  pulls?: Record<string, ReturnType<typeof vi.fn>>;
  repos?: Record<string, ReturnType<typeof vi.fn>>;
  issues?: Record<string, ReturnType<typeof vi.fn>>;
  paginate?: ReturnType<typeof vi.fn>;
}) {
  return {
    rest: {
      pulls: impl.pulls ?? {},
      repos: impl.repos ?? {},
      issues: impl.issues ?? {},
    },
    paginate: impl.paginate ?? vi.fn(async () => []),
  } as never;
}

describe('createGithubVCS', () => {
  it('throws if token is missing', () => {
    expect(() => createGithubVCS({ token: '' })).toThrow(/token/);
  });

  it('refuses non-github PRRef', async () => {
    const vcs = createGithubVCS({ token: 't', octokit: createMockOctokit({}) });
    await expect(vcs.getPR({ ...ref, platform: 'codecommit' })).rejects.toThrow(/codecommit/);
  });

  it('exposes platform=github', () => {
    const vcs = createGithubVCS({ token: 't', octokit: createMockOctokit({}) });
    expect(vcs.platform).toBe('github');
  });
});

describe('getPR', () => {
  it('maps Octokit response to PR', async () => {
    const get = vi.fn(async () => ({
      data: {
        title: 'Test PR',
        body: 'desc',
        user: { login: 'alice' },
        base: { sha: 'b', ref: 'main' },
        head: { sha: 'h', ref: 'feat' },
        draft: false,
        labels: [{ name: 'bug' }, 'priority'],
        created_at: '2026-04-30T10:00:00Z',
        updated_at: '2026-04-30T11:00:00Z',
      },
    }));
    const vcs = createGithubVCS({
      token: 't',
      octokit: createMockOctokit({ pulls: { get } }),
    });
    const pr = await vcs.getPR(ref);
    expect(pr.title).toBe('Test PR');
    expect(pr.author).toBe('alice');
    expect(pr.headSha).toBe('h');
    expect(pr.labels).toEqual(['bug', 'priority']);
  });

  it('falls back to defaults when nullable fields are absent', async () => {
    const get = vi.fn(async () => ({
      data: {
        title: 'T',
        body: null,
        user: null,
        base: { sha: 'b', ref: 'main' },
        head: { sha: 'h', ref: 'f' },
        draft: null,
        labels: [],
        created_at: 'x',
        updated_at: 'y',
      },
    }));
    const vcs = createGithubVCS({
      token: 't',
      octokit: createMockOctokit({ pulls: { get } }),
    });
    const pr = await vcs.getPR(ref);
    expect(pr.body).toBe('');
    expect(pr.author).toBe('unknown');
    expect(pr.draft).toBe(false);
  });

  it('populates commitMessages via paginate(listCommits), keeping the last 20 and truncating each at 5000 chars', async () => {
    const get = vi.fn(async () => ({
      data: {
        title: 'T',
        body: '',
        user: { login: 'a' },
        base: { sha: 'b', ref: 'main' },
        head: { sha: 'h', ref: 'f' },
        draft: false,
        labels: [],
        created_at: '',
        updated_at: '',
      },
    }));
    const listCommits = vi.fn();
    // 25 commits — should keep only the last 20.
    const commits = Array.from({ length: 25 }, (_, i) => ({
      sha: `sha${i.toString().padStart(2, '0')}`,
      commit: { message: i === 24 ? 'x'.repeat(6_000) : `commit ${i}` },
    }));
    const paginate = vi.fn(async (fn: unknown) => (fn === listCommits ? commits : []));
    const vcs = createGithubVCS({
      token: 't',
      octokit: createMockOctokit({
        pulls: { get, listCommits },
        paginate,
      }),
    });
    const pr = await vcs.getPR(ref);
    expect(pr.commitMessages).toHaveLength(20);
    // Cap: keep the trailing 20 (sha05 .. sha24).
    expect(pr.commitMessages[0]?.sha).toBe('sha05');
    expect(pr.commitMessages[19]?.sha).toBe('sha24');
    // Last commit's 6_000-char message should be truncated to 5_000 + the trailing marker.
    const last = pr.commitMessages[19];
    expect(last?.message.startsWith('x'.repeat(5_000))).toBe(true);
    expect(last?.message).toContain('[...truncated at 5000 chars]');
  });

  it('surfaces 404 from Octokit unchanged', async () => {
    const get = vi.fn(async () => {
      const err = new Error('Not Found');
      Object.assign(err, { status: 404 });
      throw err;
    });
    const vcs = createGithubVCS({
      token: 't',
      octokit: createMockOctokit({ pulls: { get } }),
    });
    await expect(vcs.getPR(ref)).rejects.toMatchObject({ status: 404 });
  });
});

describe('getDiff', () => {
  it('lists PR files via paginate when no sinceSha', async () => {
    const get = vi.fn(async () => ({
      data: {
        title: 'T',
        body: '',
        user: { login: 'a' },
        base: { sha: 'B', ref: 'main' },
        head: { sha: 'H', ref: 'f' },
        draft: false,
        labels: [],
        created_at: '',
        updated_at: '',
      },
    }));
    const listCommits = vi.fn();
    const listFiles = vi.fn();
    // `getDiff` triggers two paginated reads: `getPR` calls
    // `paginate(listCommits, …)` first to populate `commitMessages`,
    // then this test's getDiff path calls `paginate(listFiles, …)`
    // for the diff itself. Dispatch by reference so each lookup
    // returns a shape matching the call site.
    const paginate = vi.fn(async (fn: unknown) => {
      if (fn === listCommits) return [];
      return [
        {
          filename: 'a.ts',
          previous_filename: null,
          status: 'modified',
          additions: 1,
          deletions: 0,
          patch: '@@',
        },
      ];
    });
    const vcs = createGithubVCS({
      token: 't',
      octokit: createMockOctokit({
        pulls: { get, listCommits, listFiles },
        paginate,
      }),
    });
    const diff = await vcs.getDiff(ref);
    expect(diff.baseSha).toBe('B');
    expect(diff.files).toHaveLength(1);
    expect(diff.files[0]?.path).toBe('a.ts');
  });

  it('uses compare endpoint when sinceSha is provided', async () => {
    const compare = vi.fn(async () => ({
      data: {
        merge_base_commit: { sha: 'mb' },
        commits: [{ sha: 'c1' }, { sha: 'c2' }],
        files: [{ filename: 'x.ts', status: 'added', additions: 2, deletions: 0, patch: '@@' }],
      },
    }));
    const vcs = createGithubVCS({
      token: 't',
      octokit: createMockOctokit({
        repos: { compareCommitsWithBasehead: compare },
      }),
    });
    const diff = await vcs.getDiff(ref, { sinceSha: 'older' });
    expect(compare).toHaveBeenCalledWith({
      owner: 'o',
      repo: 'r',
      basehead: 'older...HEAD',
    });
    expect(diff.headSha).toBe('c2');
    expect(diff.files[0]?.status).toBe('added');
  });
});

describe('getFile', () => {
  it('returns file content as Buffer', async () => {
    const getContent = vi.fn(async () => ({
      data: {
        type: 'file',
        encoding: 'base64',
        content: Buffer.from('hello').toString('base64'),
      },
    }));
    const vcs = createGithubVCS({
      token: 't',
      octokit: createMockOctokit({ repos: { getContent } }),
    });
    const buf = await vcs.getFile(ref, 'a.txt', 'sha');
    expect(buf.toString('utf-8')).toBe('hello');
  });

  it('refuses unsafe paths', async () => {
    const vcs = createGithubVCS({
      token: 't',
      octokit: createMockOctokit({ repos: { getContent: vi.fn() } }),
    });
    await expect(vcs.getFile(ref, '../etc/passwd', 'sha')).rejects.toThrow(/traversal/);
  });

  it('throws for non-file content (directory)', async () => {
    const getContent = vi.fn(async () => ({ data: [{ type: 'file' }] }));
    const vcs = createGithubVCS({
      token: 't',
      octokit: createMockOctokit({ repos: { getContent } }),
    });
    await expect(vcs.getFile(ref, 'pkg', 'sha')).rejects.toThrow(/non-file/);
  });
});

describe('postReview', () => {
  it('uses bulk createReview with state-bearing summary', async () => {
    const createReview = vi.fn(async () => ({ data: { id: 1 } }));
    const vcs = createGithubVCS({
      token: 't',
      octokit: createMockOctokit({ pulls: { createReview } }),
    });
    const review: ReviewPayload = {
      summary: 'Looks good.',
      comments: [
        {
          path: 'a.ts',
          line: 1,
          side: 'RIGHT',
          body: 'note',
          severity: 'info',
          fingerprint: 'fp1',
        },
      ],
      state: validState,
    };
    await vcs.postReview(ref, review);
    expect(createReview).toHaveBeenCalledTimes(1);
    const args = createReview.mock.calls[0]?.[0] as {
      event: string;
      body: string;
      comments: { line: number }[];
    };
    expect(args.event).toBe('COMMENT');
    expect(args.body).toContain('<!-- review-agent-state:');
    expect(args.comments).toHaveLength(1);
    expect(args.comments[0]?.line).toBe(1);
  });
});

describe('getStateComment / upsertStateComment', () => {
  it('returns null when no marker is present', async () => {
    const paginate = vi.fn(async () => [{ id: 1, body: 'irrelevant' }]);
    const vcs = createGithubVCS({
      token: 't',
      octokit: createMockOctokit({ paginate, issues: { listComments: vi.fn() } }),
    });
    expect(await vcs.getStateComment(ref)).toBeNull();
  });

  it('finds the latest state-bearing comment', async () => {
    const marker = `<!-- review-agent-state: ${JSON.stringify(validState)} -->`;
    const paginate = vi.fn(async () => [
      { id: 1, body: 'old' },
      { id: 2, body: marker },
      { id: 3, body: 'newer unrelated' },
    ]);
    const vcs = createGithubVCS({
      token: 't',
      octokit: createMockOctokit({ paginate, issues: { listComments: vi.fn() } }),
    });
    const got = await vcs.getStateComment(ref);
    expect(got?.lastReviewedSha).toBe(validState.lastReviewedSha);
  });

  it('forwards schema_mismatch events to onStateParseEvent', async () => {
    const forwardRolled = JSON.stringify({ ...validState, schemaVersion: 2 });
    const paginate = vi.fn(async () => [
      { id: 1, body: `<!-- review-agent-state: ${forwardRolled} -->` },
    ]);
    const onStateParseEvent = vi.fn();
    const vcs = createGithubVCS({
      token: 't',
      octokit: createMockOctokit({ paginate, issues: { listComments: vi.fn() } }),
      onStateParseEvent,
    });
    const got = await vcs.getStateComment(ref);
    expect(got).toBeNull();
    expect(onStateParseEvent).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'schema_mismatch', foundVersion: 2 }),
    );
  });

  it('forwards validation_failure events to onStateParseEvent', async () => {
    const corrupted = JSON.stringify({ ...validState, totalCostUsd: -1 });
    const paginate = vi.fn(async () => [
      { id: 1, body: `<!-- review-agent-state: ${corrupted} -->` },
    ]);
    const onStateParseEvent = vi.fn();
    const vcs = createGithubVCS({
      token: 't',
      octokit: createMockOctokit({ paginate, issues: { listComments: vi.fn() } }),
      onStateParseEvent,
    });
    const got = await vcs.getStateComment(ref);
    expect(got).toBeNull();
    expect(onStateParseEvent).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'validation_failure' }),
    );
  });

  it('updates existing state comment when one exists', async () => {
    const paginate = vi.fn(async () => [
      { id: 7, body: '<!-- review-agent-state: {"x":true} -->' },
    ]);
    const updateComment = vi.fn(async () => ({ data: {} }));
    const createComment = vi.fn(async () => ({ data: { id: 99 } }));
    const vcs = createGithubVCS({
      token: 't',
      octokit: createMockOctokit({
        paginate,
        issues: { listComments: vi.fn(), updateComment, createComment },
      }),
    });
    await vcs.upsertStateComment(ref, validState);
    expect(updateComment).toHaveBeenCalledWith(expect.objectContaining({ comment_id: 7 }));
    expect(createComment).not.toHaveBeenCalled();
  });

  it('creates new state comment when none exists', async () => {
    const paginate = vi.fn(async () => []);
    const updateComment = vi.fn();
    const createComment = vi.fn(async () => ({ data: { id: 12 } }));
    const vcs = createGithubVCS({
      token: 't',
      octokit: createMockOctokit({
        paginate,
        issues: { listComments: vi.fn(), updateComment, createComment },
      }),
    });
    await vcs.upsertStateComment(ref, validState);
    expect(createComment).toHaveBeenCalled();
    expect(updateComment).not.toHaveBeenCalled();
  });
});

describe('postSummary', () => {
  it('returns the new comment id as a string', async () => {
    const createComment = vi.fn(async () => ({ data: { id: 42 } }));
    const vcs = createGithubVCS({
      token: 't',
      octokit: createMockOctokit({ issues: { createComment } }),
    });
    const result = await vcs.postSummary(ref, 'hello');
    expect(result).toEqual({ commentId: '42' });
  });
});

describe('getExistingComments', () => {
  it('maps Octokit review-comments to ExistingComment', async () => {
    const paginate = vi.fn(async () => [
      {
        id: 1,
        path: 'a.ts',
        line: 5,
        original_line: 5,
        side: 'RIGHT',
        body: 'note',
        user: { login: 'bot' },
        created_at: 'now',
      },
    ]);
    const vcs = createGithubVCS({
      token: 't',
      octokit: createMockOctokit({ paginate, pulls: { listReviewComments: vi.fn() } }),
    });
    const got = await vcs.getExistingComments(ref);
    expect(got).toHaveLength(1);
    expect(got[0]?.author).toBe('bot');
    expect(got[0]?.line).toBe(5);
  });
});
