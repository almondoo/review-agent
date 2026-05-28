import type { DbClient } from '@review-agent/db';
import { describe, expect, it, vi } from 'vitest';
import {
  type BackfillOctokit,
  type BackfillPr,
  type BackfillReaction,
  type BackfillReviewComment,
  type BackfillStateFile,
  feedbackBackfillCommand,
  resolveFingerprint,
} from './feedback-backfill.js';

function recordingIo() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    stdout: (c: string) => {
      out.push(c);
    },
    stderr: (c: string) => {
      err.push(c);
    },
    exit: () => {},
  };
}

const fakeDb = {} as DbClient;
const fakeCreateDb = () => ({ db: fakeDb, close: async () => undefined });

function makeOctokit(args: {
  prs?: ReadonlyArray<BackfillPr>;
  prsByPage?: ReadonlyArray<ReadonlyArray<BackfillPr>>;
  commentsByPr?: Record<number, ReadonlyArray<BackfillReviewComment>>;
  commentsByPrByPage?: Record<number, ReadonlyArray<ReadonlyArray<BackfillReviewComment>>>;
  reactionsByComment?: Record<number, ReadonlyArray<BackfillReaction>>;
  reactionsByCommentByPage?: Record<number, ReadonlyArray<ReadonlyArray<BackfillReaction>>>;
}): BackfillOctokit & {
  calls: { prsList: number; reviewComments: number; reactions: number };
} {
  const calls = { prsList: 0, reviewComments: 0, reactions: 0 };
  return {
    calls,
    rest: {
      pulls: {
        list: async (q) => {
          calls.prsList += 1;
          if (args.prsByPage) {
            const data = args.prsByPage[q.page - 1] ?? [];
            return { data };
          }
          return { data: q.page === 1 ? (args.prs ?? []) : [] };
        },
        listReviewComments: async (q) => {
          calls.reviewComments += 1;
          if (args.commentsByPrByPage?.[q.pull_number]) {
            const data = args.commentsByPrByPage[q.pull_number]?.[q.page - 1] ?? [];
            return { data };
          }
          return {
            data: q.page === 1 ? (args.commentsByPr?.[q.pull_number] ?? []) : [],
          };
        },
      },
      reactions: {
        listForPullRequestReviewComment: async (q) => {
          calls.reactions += 1;
          if (args.reactionsByCommentByPage?.[q.comment_id]) {
            const data = args.reactionsByCommentByPage[q.comment_id]?.[q.page - 1] ?? [];
            return { data };
          }
          return {
            data: q.page === 1 ? (args.reactionsByComment?.[q.comment_id] ?? []) : [],
          };
        },
      },
    },
  };
}

function botComment(overrides: Partial<BackfillReviewComment> = {}): BackfillReviewComment {
  return {
    id: 1,
    path: 'src/foo.ts',
    line: 10,
    body: 'pre-comment body',
    user: { login: 'review-agent[bot]', type: 'Bot' },
    ...overrides,
  };
}

function reaction(overrides: Partial<BackfillReaction> = {}): BackfillReaction {
  return {
    id: 100,
    content: '+1',
    user: { login: 'alice' },
    created_at: '2026-05-18T12:00:00Z',
    ...overrides,
  };
}

const baseEnv: NodeJS.ProcessEnv = {
  REVIEW_AGENT_GH_TOKEN: 't',
  DATABASE_URL: 'postgres://x',
} as NodeJS.ProcessEnv;

describe('feedbackBackfillCommand', () => {
  it('rejects --platform codecommit with an informative pointer to #95', async () => {
    const io = recordingIo();
    const result = await feedbackBackfillCommand(io, {
      installationId: 1n,
      repo: 'demo',
      env: {} as NodeJS.ProcessEnv,
      platform: 'codecommit',
    });
    expect(result.status).toBe('platform_unsupported');
    expect(io.err.join('')).toContain('GitHub-only');
    expect(io.err.join('')).toContain('#95');
    expect(io.err.join('')).toContain('feedback-backfill.md');
  });

  it('rejects malformed --repo strings', async () => {
    const io = recordingIo();
    const result = await feedbackBackfillCommand(io, {
      installationId: 1n,
      repo: 'not-valid',
      env: baseEnv,
    });
    expect(result.status).toBe('invalid_args');
    expect(io.err.join('')).toContain("'owner/repo' format");
  });

  it('rejects malformed --since values', async () => {
    const io = recordingIo();
    const result = await feedbackBackfillCommand(io, {
      installationId: 1n,
      repo: 'o/r',
      since: 'last week',
      env: baseEnv,
    });
    expect(result.status).toBe('invalid_args');
    expect(io.err.join('')).toContain('--since');
  });

  it('rejects non-positive --rate', async () => {
    const io = recordingIo();
    const result = await feedbackBackfillCommand(io, {
      installationId: 1n,
      repo: 'o/r',
      rate: 0,
      env: baseEnv,
    });
    expect(result.status).toBe('invalid_args');
    expect(io.err.join('')).toContain('--rate');
  });

  it('reports auth_failed without REVIEW_AGENT_GH_TOKEN / GITHUB_TOKEN', async () => {
    const io = recordingIo();
    const result = await feedbackBackfillCommand(io, {
      installationId: 1n,
      repo: 'o/r',
      env: {} as NodeJS.ProcessEnv,
    });
    expect(result.status).toBe('auth_failed');
    expect(io.err.join('')).toContain('REVIEW_AGENT_GH_TOKEN');
  });

  it('reports config_error without DATABASE_URL when not dry-run', async () => {
    const io = recordingIo();
    const result = await feedbackBackfillCommand(io, {
      installationId: 1n,
      repo: 'o/r',
      env: { REVIEW_AGENT_GH_TOKEN: 't' } as NodeJS.ProcessEnv,
      createOctokit: () => makeOctokit({}),
    });
    expect(result.status).toBe('config_error');
    expect(io.err.join('')).toContain('DATABASE_URL');
  });

  it('paginates PRs and review comments, ingesting +1/-1 reactions and dropping noise', async () => {
    const io = recordingIo();
    const buildWriter = vi.fn(() => vi.fn(async () => undefined));
    const octokit = makeOctokit({
      prs: [{ number: 1 }, { number: 2 }],
      commentsByPr: {
        1: [
          botComment({ id: 10 }),
          botComment({ id: 11, path: 'src/bar.ts', line: 20 }),
          botComment({ id: 12, path: 'src/baz.ts', line: 30 }),
        ],
        2: [botComment({ id: 20 })],
      },
      reactionsByComment: {
        10: [reaction({ id: 100, content: '+1' }), reaction({ id: 101, content: 'heart' })],
        11: [reaction({ id: 110, content: '-1', user: { login: 'bob' } })],
        12: [],
        20: [reaction({ id: 200, content: '+1' })],
      },
    });

    const result = await feedbackBackfillCommand(io, {
      installationId: 42n,
      repo: 'o/r',
      env: baseEnv,
      rate: 1000, // effectively no delay; just keep wall-clock fast
      createOctokit: () => octokit,
      createDb: fakeCreateDb,
      buildWriter,
      sleep: async () => undefined,
    });

    expect(result.status).toBe('ok');
    // 1 (+1 on c10) + 1 (-1 on c11) + 1 (+1 on c20) = 3 processed
    // heart reaction was dropped (mapped to null).
    expect(result.processed).toBe(3);
    expect(result.recorded).toBe(3);
    expect(result.skipped).toBe(0);
    expect(result.unresolved).toBe(0);
    // PR list paginated through page 1 (returning <100 rows → stops).
    expect(octokit.calls.prsList).toBe(1);
    // 1 review-comments call per PR (both PR pages return <100 rows
    // so pagination stops). 4 reactions calls (one per bot comment).
    expect(octokit.calls.reviewComments).toBe(2);
    expect(octokit.calls.reactions).toBe(4);
    expect(io.out.join('')).toContain('processed: 3');
    expect(io.out.join('')).toContain('recorded: 3');
  });

  it('issues a follow-up review-comments page when the first returns a full page', async () => {
    // Drive pagination explicitly with two pages of exactly
    // COMMENT_PAGE_SIZE rows. The CLI must request page 2 even when
    // page 1 was full.
    const io = recordingIo();
    const page1: BackfillReviewComment[] = [];
    for (let i = 1; i <= 100; i += 1) {
      page1.push(botComment({ id: i, path: 'src/a.ts', line: i }));
    }
    const octokit = makeOctokit({
      prs: [{ number: 1 }],
      commentsByPrByPage: { 1: [page1, [botComment({ id: 1000 })]] },
      reactionsByComment: {},
    });
    const result = await feedbackBackfillCommand(io, {
      installationId: 1n,
      repo: 'o/r',
      env: baseEnv,
      rate: 1000,
      createOctokit: () => octokit,
      createDb: fakeCreateDb,
      buildWriter: () => vi.fn(async () => undefined),
      sleep: async () => undefined,
    });
    expect(result.status).toBe('ok');
    // We expect at least 2 listReviewComments calls — proves pagination.
    expect(octokit.calls.reviewComments).toBeGreaterThanOrEqual(2);
  });

  it('records the per-PR run shape and resumes from a prior state file', async () => {
    // Simulated prior run: PR #1 was completed; PR #2 has its
    // first comment partially processed. On resume we should
    // continue from PR #2's next comment / reaction.
    const ioFirst = recordingIo();
    const prior: BackfillStateFile = {
      version: 1,
      repo: 'o/r',
      installationId: '42',
      prs: {
        'pr#1': {
          lastCommentId: 12,
          lastReactionId: 0,
          processed: 1,
          recorded: 1,
          unresolved: 0,
          skipped: 0,
          completed: true,
        },
        'pr#2': {
          lastCommentId: 20,
          lastReactionId: 200,
          processed: 1,
          recorded: 1,
          unresolved: 0,
          skipped: 0,
          completed: false,
        },
      },
    };
    let written: string | null = null;
    const octokit = makeOctokit({
      prs: [{ number: 1 }, { number: 2 }],
      commentsByPr: {
        2: [
          botComment({ id: 20 }), // already partially processed
          botComment({ id: 21, path: 'src/new.ts', line: 5 }), // new
        ],
      },
      reactionsByComment: {
        20: [
          // id 200 was already processed in the prior run; id 201 is new.
          reaction({ id: 200, content: '+1' }),
          reaction({ id: 201, content: '-1', user: { login: 'late-reviewer' } }),
        ],
        21: [reaction({ id: 210, content: '+1' })],
      },
    });
    const result = await feedbackBackfillCommand(ioFirst, {
      installationId: 42n,
      repo: 'o/r',
      stateFile: 'tmp/backfill.json',
      env: baseEnv,
      rate: 1000,
      createOctokit: () => octokit,
      createDb: fakeCreateDb,
      buildWriter: () => vi.fn(async () => undefined),
      readState: async () => JSON.stringify(prior),
      writeState: async (_p, data) => {
        written = data;
      },
      sleep: async () => undefined,
    });
    expect(result.status).toBe('ok');
    // Prior PR#1: 1 processed (rolled forward). Prior PR#2: 1 processed (rolled forward),
    // plus this run: reaction 201 on c20 (+1 new) + reaction 210 on c21 = 2 new.
    expect(result.processed).toBe(4);
    expect(result.recorded).toBe(4);
    // PR #1 was completed → no review-comment calls for it.
    // Per-PR state file is flushed after each PR completes.
    expect(written).not.toBeNull();
    const flushed = JSON.parse(written as unknown as string) as BackfillStateFile;
    expect(flushed.prs['pr#2']?.completed).toBe(true);
    expect(ioFirst.out.join('')).toContain('#1: already completed');
  });

  it('reports planned writes in dry-run mode without invoking the writer', async () => {
    const io = recordingIo();
    const buildWriter = vi.fn();
    const octokit = makeOctokit({
      prs: [{ number: 5 }],
      commentsByPr: { 5: [botComment({ id: 30 })] },
      reactionsByComment: { 30: [reaction({ id: 300, content: '+1' })] },
    });
    const result = await feedbackBackfillCommand(io, {
      installationId: 1n,
      repo: 'o/r',
      env: { REVIEW_AGENT_GH_TOKEN: 't' } as NodeJS.ProcessEnv, // no DB url
      dryRun: true,
      rate: 1000,
      createOctokit: () => octokit,
      buildWriter,
      sleep: async () => undefined,
    });
    expect(result.status).toBe('dry_run');
    expect(result.processed).toBe(1);
    expect(result.recorded).toBe(1);
    expect(buildWriter).not.toHaveBeenCalled();
    expect(io.out.join('')).toContain('(dry-run)');
  });

  it('drops bot comments with unresolvable fingerprints and counts them as unresolved', async () => {
    const io = recordingIo();
    const octokit = makeOctokit({
      prs: [{ number: 7 }],
      commentsByPr: {
        7: [
          // No path → resolveFingerprint returns null.
          botComment({ id: 40, path: null, line: null }),
          botComment({ id: 41, path: 'src/x.ts', line: 1 }),
        ],
      },
      reactionsByComment: {
        41: [reaction({ id: 410, content: '+1' })],
      },
    });
    const result = await feedbackBackfillCommand(io, {
      installationId: 1n,
      repo: 'o/r',
      env: baseEnv,
      rate: 1000,
      createOctokit: () => octokit,
      createDb: fakeCreateDb,
      buildWriter: () => vi.fn(async () => undefined),
      sleep: async () => undefined,
    });
    expect(result.status).toBe('ok');
    expect(result.processed).toBe(1);
    expect(result.unresolved).toBe(1);
    expect(io.out.join('')).toContain('unresolved fingerprint');
  });

  it('uses the embedded <!-- fingerprint:<fp> --> marker when present', () => {
    const fp = resolveFingerprint({
      id: 1,
      path: 'src/a.ts',
      line: 2,
      body: 'see issue\n<!-- fingerprint:abcdef0123456789 -->\n',
    });
    expect(fp).toBe('abcdef0123456789');
  });

  it('falls back to recomputed fingerprint from (path,line,ruleId,suggestionType=comment)', () => {
    const fp1 = resolveFingerprint({
      id: 1,
      path: 'src/a.ts',
      line: 2,
      body: 'no marker',
    });
    const fp2 = resolveFingerprint({
      id: 1,
      path: 'src/a.ts',
      line: 2,
      body: 'no marker either',
    });
    expect(fp1).not.toBeNull();
    // Deterministic for the same (path, line) — so resume picks up
    // exactly the row a prior run would have written.
    expect(fp1).toBe(fp2);
  });

  it('honors a rate-limit delay between requests (sleep called with derived delayMs)', async () => {
    const io = recordingIo();
    vi.useFakeTimers();
    try {
      const sleep = vi.fn(async () => undefined);
      const octokit = makeOctokit({
        prs: [{ number: 1 }],
        commentsByPr: { 1: [botComment({ id: 10 })] },
        reactionsByComment: { 10: [reaction({ id: 100, content: '+1' })] },
      });
      const result = await feedbackBackfillCommand(io, {
        installationId: 1n,
        repo: 'o/r',
        env: baseEnv,
        rate: 4, // 1000/4 = 250ms between API calls
        createOctokit: () => octokit,
        createDb: fakeCreateDb,
        buildWriter: () => vi.fn(async () => undefined),
        sleep,
      });
      expect(result.status).toBe('ok');
      // Sleep is called before each reactions/listReviewComments
      // page request after the first. At minimum we expect the
      // delay to be the rate-derived value (250).
      const delays = sleep.mock.calls.map((c) => c[0] as number);
      expect(delays.length).toBeGreaterThan(0);
      for (const d of delays) {
        expect(d).toBe(250);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('accepts a full ISO 8601 --since with explicit time component', async () => {
    // parseIsoDate's `value.includes('T') ? new Date(value) : new Date(`${value}T00:00:00Z`)`
    // — the truthy `includes('T')` arm. The other --since tests pass
    // bare YYYY-MM-DD; this pins the explicit-time path.
    const io = recordingIo();
    const result = await feedbackBackfillCommand(io, {
      installationId: 1n,
      repo: 'o/r',
      since: '2026-01-15T12:00:00Z',
      env: baseEnv,
      rate: 1000,
      createOctokit: () => makeOctokit({}),
      createDb: fakeCreateDb,
      buildWriter: () => vi.fn(async () => undefined),
      sleep: async () => undefined,
    });
    expect(result.status).toBe('ok');
    expect(io.err.join('')).not.toContain('--since');
  });

  it('rejects a --since that matches the YYYY-MM-DD shape but encodes an unparseable date', async () => {
    // parseIsoDate's `Number.isNaN(parsed.getTime()) ? null : parsed`
    // — the truthy `isNaN` arm. `'2026-13-45'` passes the regex (digits)
    // but `new Date(...)` produces Invalid Date.
    const io = recordingIo();
    const result = await feedbackBackfillCommand(io, {
      installationId: 1n,
      repo: 'o/r',
      since: '2026-13-45',
      env: baseEnv,
    });
    expect(result.status).toBe('invalid_args');
    expect(io.err.join('')).toContain('--since');
  });

  it("rolls --since into PR pagination — stops once a PR's updated_at predates the cutoff", async () => {
    const io = recordingIo();
    const octokit = makeOctokit({
      prs: [
        { number: 30, updated_at: '2026-04-01T00:00:00Z' },
        { number: 31, updated_at: '2025-12-01T00:00:00Z' }, // before --since
        { number: 32, updated_at: '2026-04-15T00:00:00Z' }, // would still iterate without --since
      ],
      commentsByPr: {
        30: [botComment({ id: 1 })],
        31: [botComment({ id: 2 })],
        32: [botComment({ id: 3 })],
      },
      reactionsByComment: {
        1: [reaction({ id: 100, content: '+1' })],
        2: [reaction({ id: 101, content: '+1' })],
        3: [reaction({ id: 102, content: '+1' })],
      },
    });
    const result = await feedbackBackfillCommand(io, {
      installationId: 1n,
      repo: 'o/r',
      since: '2026-01-01',
      env: baseEnv,
      rate: 1000,
      createOctokit: () => octokit,
      createDb: fakeCreateDb,
      buildWriter: () => vi.fn(async () => undefined),
      sleep: async () => undefined,
    });
    // We stop at PR #31 because its updated_at is before --since.
    expect(result.processed).toBe(1);
  });

  it('treats a missing state-file as an empty resume baseline', async () => {
    const io = recordingIo();
    const result = await feedbackBackfillCommand(io, {
      installationId: 1n,
      repo: 'o/r',
      stateFile: 'tmp/never-written.json',
      env: baseEnv,
      rate: 1000,
      createOctokit: () => makeOctokit({}),
      createDb: fakeCreateDb,
      buildWriter: () => vi.fn(async () => undefined),
      readState: async () => null,
      writeState: async () => undefined,
      sleep: async () => undefined,
    });
    expect(result.status).toBe('ok');
    expect(result.processed).toBe(0);
  });

  it('rejects a state-file with malformed JSON', async () => {
    const io = recordingIo();
    await expect(() =>
      feedbackBackfillCommand(io, {
        installationId: 1n,
        repo: 'o/r',
        stateFile: 'tmp/broken.json',
        env: baseEnv,
        rate: 1000,
        createOctokit: () => makeOctokit({}),
        createDb: fakeCreateDb,
        readState: async () => 'not json',
        writeState: async () => undefined,
        sleep: async () => undefined,
      }),
    ).rejects.toThrow(/not valid JSON/);
  });

  it('rejects a state-file whose shape does not match BackfillStateFile', async () => {
    const io = recordingIo();
    await expect(() =>
      feedbackBackfillCommand(io, {
        installationId: 1n,
        repo: 'o/r',
        stateFile: 'tmp/bad-shape.json',
        env: baseEnv,
        rate: 1000,
        createOctokit: () => makeOctokit({}),
        createDb: fakeCreateDb,
        readState: async () => JSON.stringify({ version: 99 }),
        writeState: async () => undefined,
        sleep: async () => undefined,
      }),
    ).rejects.toThrow(/schema does not match/);
  });

  it('only ingests reactions on the configured --bot-login when set', async () => {
    const io = recordingIo();
    const octokit = makeOctokit({
      prs: [{ number: 1 }],
      commentsByPr: {
        1: [
          botComment({ id: 10, user: { login: 'review-agent[bot]', type: 'Bot' } }),
          botComment({ id: 11, user: { login: 'other-bot[bot]', type: 'Bot' } }),
          botComment({ id: 12, user: { login: 'human-reviewer', type: 'User' } }),
        ],
      },
      reactionsByComment: {
        10: [reaction({ id: 100, content: '+1' })],
        11: [reaction({ id: 110, content: '+1' })],
        12: [reaction({ id: 120, content: '+1' })],
      },
    });
    const result = await feedbackBackfillCommand(io, {
      installationId: 1n,
      repo: 'o/r',
      botLogin: 'review-agent[bot]',
      env: baseEnv,
      rate: 1000,
      createOctokit: () => octokit,
      createDb: fakeCreateDb,
      buildWriter: () => vi.fn(async () => undefined),
      sleep: async () => undefined,
    });
    // Only comment 10 matches the pinned bot-login; the other two
    // are filtered out before reactions are fetched.
    expect(result.processed).toBe(1);
  });

  it('paginates reactions when the first page returns a full REACTION_PAGE_SIZE batch', async () => {
    // The reaction-loop's pagination is otherwise dead because every
    // existing test has <100 reactions per comment. We feed exactly
    // REACTION_PAGE_SIZE (100) +1 reactions on a single comment and
    // confirm the CLI issues a second reactions page request.
    const io = recordingIo();
    const page1: BackfillReaction[] = [];
    for (let i = 1; i <= 100; i += 1) {
      page1.push(reaction({ id: i, content: '+1' }));
    }
    const page2: BackfillReaction[] = [reaction({ id: 200, content: '+1' })];
    const octokit = makeOctokit({
      prs: [{ number: 1 }],
      commentsByPr: { 1: [botComment({ id: 10 })] },
      reactionsByCommentByPage: { 10: [page1, page2, []] },
    });
    const result = await feedbackBackfillCommand(io, {
      installationId: 1n,
      repo: 'o/r',
      env: baseEnv,
      rate: 1000,
      createOctokit: () => octokit,
      createDb: fakeCreateDb,
      buildWriter: () => vi.fn(async () => undefined),
      sleep: async () => undefined,
    });
    expect(result.status).toBe('ok');
    // 101 +1 reactions processed across two pages.
    expect(result.processed).toBe(101);
    expect(octokit.calls.reactions).toBeGreaterThanOrEqual(2);
  });

  it('skips comments that were already processed in a prior run (id < startCommentId)', async () => {
    // The `if (comment.id < startCommentId) continue;` resume invariant
    // — drive it by handing a state file whose `pr#1.lastCommentId` is
    // larger than the first listed comment so the iteration must skip it.
    const io = recordingIo();
    const prior: BackfillStateFile = {
      version: 1,
      repo: 'o/r',
      installationId: '1',
      prs: {
        'pr#1': {
          lastCommentId: 50,
          lastReactionId: 0,
          processed: 1,
          recorded: 1,
          unresolved: 0,
          skipped: 0,
          completed: false,
        },
      },
    };
    const octokit = makeOctokit({
      prs: [{ number: 1 }],
      commentsByPr: {
        1: [
          // id 10 < startCommentId=50 → skipped without fetching reactions.
          botComment({ id: 10 }),
          // id 60 > startCommentId → processed normally.
          botComment({ id: 60, path: 'src/new.ts', line: 5 }),
        ],
      },
      reactionsByComment: {
        // Only the high-id comment's reactions should be fetched.
        60: [reaction({ id: 600, content: '+1' })],
      },
    });
    const result = await feedbackBackfillCommand(io, {
      installationId: 1n,
      repo: 'o/r',
      stateFile: 'tmp/resume.json',
      env: baseEnv,
      rate: 1000,
      createOctokit: () => octokit,
      createDb: fakeCreateDb,
      buildWriter: () => vi.fn(async () => undefined),
      readState: async () => JSON.stringify(prior),
      writeState: async () => undefined,
      sleep: async () => undefined,
    });
    expect(result.status).toBe('ok');
    // Prior 1 + this run's 1 (new comment) = 2 processed.
    expect(result.processed).toBe(2);
    // Reactions fetched only for the post-resume comment.
    expect(octokit.calls.reactions).toBe(1);
  });

  it('closes the DB connection even when ingestion throws', async () => {
    const io = recordingIo();
    const close = vi.fn(async () => undefined);
    const failWriter = vi.fn(async () => {
      throw new Error('writer down');
    });
    const octokit = makeOctokit({
      prs: [{ number: 1 }],
      commentsByPr: { 1: [botComment({ id: 10 })] },
      reactionsByComment: { 10: [reaction({ id: 100, content: '+1' })] },
    });
    await expect(() =>
      feedbackBackfillCommand(io, {
        installationId: 1n,
        repo: 'o/r',
        env: baseEnv,
        rate: 1000,
        createOctokit: () => octokit,
        createDb: () => ({ db: fakeDb, close }),
        buildWriter: () => failWriter,
        sleep: async () => undefined,
      }),
    ).rejects.toThrow(/writer down/);
    expect(close).toHaveBeenCalledOnce();
  });
});
