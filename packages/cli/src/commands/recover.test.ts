import type { ReviewState, VCS } from '@review-agent/core';
import { describe, expect, it, vi } from 'vitest';
import {
  recoverFeedbackHistoryCommand,
  recoverReviewEvalEventsCommand,
  recoverSyncStateCommand,
} from './recover.js';

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

function fakeState(overrides: Partial<ReviewState> = {}): ReviewState {
  return {
    schemaVersion: 1,
    lastReviewedSha: 'h1',
    baseSha: 'b1',
    reviewedAt: '2026-04-30T00:00:00Z',
    modelUsed: 'claude',
    totalTokens: 0,
    totalCostUsd: 0,
    commentFingerprints: [],
    ...overrides,
  };
}

function fakeVcs(stateByPr: Record<number, ReviewState | null>): VCS {
  return {
    platform: 'github',
    capabilities: {
      clone: true,
      stateComment: 'native',
      approvalEvent: 'github',
      commitMessages: true,
    },
    getPR: async () => {
      throw new Error('unused');
    },
    getDiff: async () => ({ baseSha: 'b', headSha: 'h', files: [] }),
    getFile: async () => Buffer.from(''),
    cloneRepo: async () => undefined,
    postReview: async () => undefined,
    postSummary: async () => ({ commentId: 'c' }),
    getExistingComments: async () => [],
    getStateComment: async (ref) => stateByPr[ref.number] ?? null,
    upsertStateComment: async () => undefined,
  };
}

const baseEnv = { REVIEW_AGENT_GH_TOKEN: 't' } as NodeJS.ProcessEnv;

describe('recoverSyncStateCommand', () => {
  it('reports auth_failed without GH token', async () => {
    const io = recordingIo();
    const result = await recoverSyncStateCommand(io, {
      repo: 'o/r',
      installationId: 1n,
      env: {} as NodeJS.ProcessEnv,
    });
    expect(result.status).toBe('auth_failed');
    expect(io.err.join('')).toContain('REVIEW_AGENT_GH_TOKEN');
  });

  it('rejects malformed --repo strings', async () => {
    const io = recordingIo();
    await expect(() =>
      recoverSyncStateCommand(io, {
        repo: 'not-valid',
        installationId: 1n,
        env: baseEnv,
      }),
    ).rejects.toThrow(/owner\/repo/);
  });

  it('upserts each PR with a hidden state comment and returns ok', async () => {
    const io = recordingIo();
    const upsertState = vi.fn(async () => undefined);
    const result = await recoverSyncStateCommand(io, {
      repo: 'o/r',
      installationId: 42n,
      env: baseEnv,
      listOpenPRs: async () => [{ number: 1 }, { number: 2 }],
      createVCS: () =>
        fakeVcs({
          1: fakeState({ lastReviewedSha: 'sha-1' }),
          2: fakeState({ lastReviewedSha: 'sha-2' }),
        }),
      upsertState,
    });
    expect(result.status).toBe('ok');
    expect(result.recovered).toBe(2);
    expect(upsertState).toHaveBeenCalledTimes(2);
    expect(upsertState.mock.calls[0]?.[0]).toMatchObject({
      installationId: 42n,
      prId: 'o/r#1',
      headSha: 'sha-1',
    });
  });

  it('reports partial when some PRs lack a state comment', async () => {
    const io = recordingIo();
    const upsertState = vi.fn(async () => undefined);
    const result = await recoverSyncStateCommand(io, {
      repo: 'o/r',
      installationId: 1n,
      env: baseEnv,
      listOpenPRs: async () => [{ number: 1 }, { number: 2 }],
      createVCS: () =>
        fakeVcs({
          1: fakeState(),
          2: null,
        }),
      upsertState,
    });
    expect(result.status).toBe('partial');
    expect(result.recovered).toBe(1);
    expect(result.missing).toEqual([2]);
    expect(io.out.join('')).toContain('1 skipped: [2]');
  });

  it('skips PRs whose state has no lastReviewedSha', async () => {
    const io = recordingIo();
    const upsertState = vi.fn(async () => undefined);
    const result = await recoverSyncStateCommand(io, {
      repo: 'o/r',
      installationId: 1n,
      env: baseEnv,
      listOpenPRs: async () => [{ number: 9 }],
      createVCS: () =>
        fakeVcs({
          9: fakeState({ lastReviewedSha: '' }),
        }),
      upsertState,
    });
    expect(result.recovered).toBe(0);
    expect(result.missing).toEqual([9]);
    expect(upsertState).not.toHaveBeenCalled();
  });

  it('short-circuits on --platform codecommit with informative stderr', async () => {
    const io = recordingIo();
    const result = await recoverSyncStateCommand(io, {
      repo: 'demo',
      installationId: 1n,
      env: {} as NodeJS.ProcessEnv,
      platform: 'codecommit',
    });
    expect(result).toEqual({ status: 'ok', recovered: 0, missing: [] });
    expect(io.err.join('')).toContain('recover sync-state is GitHub-only');
    expect(io.err.join('')).toContain('codecommit-disaster-recovery');
  });

  it('handles an empty repo (no open PRs)', async () => {
    const io = recordingIo();
    const upsertState = vi.fn(async () => undefined);
    const result = await recoverSyncStateCommand(io, {
      repo: 'o/r',
      installationId: 1n,
      env: baseEnv,
      listOpenPRs: async () => [],
      createVCS: () => fakeVcs({}),
      upsertState,
    });
    expect(result).toEqual({ status: 'ok', recovered: 0, missing: [] });
    expect(io.out.join('')).toContain('Found 0 open PR(s)');
  });
});

describe('recoverReviewEvalEventsCommand (#105)', () => {
  it('errors out without DATABASE_URL', async () => {
    const io = recordingIo();
    const result = await recoverReviewEvalEventsCommand(io, {
      repo: 'almondoo/review-agent',
      installationId: 1n,
      env: {} as NodeJS.ProcessEnv,
    });
    expect(result).toEqual({
      status: 'ok',
      candidates: 0,
      recovered: 0,
      skippedExisting: 0,
    });
    expect(io.err.join('')).toContain('DATABASE_URL is required');
  });

  it('reports recovery counts from the createDb seam (zero candidates path)', async () => {
    const io = recordingIo();
    const close = vi.fn(async () => undefined);
    // Stub the db.select(...).from(...).where(...).groupBy(...) chain so
    // candidateRows resolves to []. The helper's early-return at
    // candidates=0 then exercises the format + close path without
    // needing the full Drizzle chain mocked.
    const groupBy = vi.fn(async () => []);
    const where = vi.fn(() => ({ groupBy }));
    const from = vi.fn(() => ({ where }));
    const fakeDb = {
      transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(fakeDb),
      execute: vi.fn(async () => []),
      select: vi.fn(() => ({ from })),
      insert: vi.fn(() => ({ values: vi.fn(async () => undefined) })),
    };

    const result = await recoverReviewEvalEventsCommand(io, {
      repo: 'almondoo/review-agent',
      installationId: 42n,
      env: { DATABASE_URL: 'postgres://stub' } as NodeJS.ProcessEnv,
      dryRun: true,
      // biome-ignore lint/suspicious/noExplicitAny: stubbed DB client shape
      createDb: () => ({ db: fakeDb as any, close }),
    });
    expect(result).toEqual({
      status: 'ok',
      candidates: 0,
      recovered: 0,
      skippedExisting: 0,
    });
    expect(close).toHaveBeenCalledTimes(1);
    expect(io.out.join('')).toContain('review-eval-events recovery for installation=42');
    expect(io.out.join('')).toContain('dry-run; no inserts');
  });
});

describe('recoverFeedbackHistoryCommand (#105)', () => {
  it('--platform codecommit walks PR comments via the injected client (dry-run, #110)', async () => {
    const io = recordingIo();
    const close = vi.fn(async () => undefined);
    // Stub the CodeCommit SDK client: empty repo (zero PRs) so the
    // path through the helper exits without any candidates.
    const codecommitClient = {
      send: vi.fn(async (cmd: { constructor: { name: string } }) => {
        if (cmd.constructor.name === 'ListPullRequestsCommand') {
          return { pullRequestIds: [] };
        }
        throw new Error(`Unmocked SDK command: ${cmd.constructor.name}`);
      }),
      // biome-ignore lint/suspicious/noExplicitAny: stubbed SDK client
    } as any;
    const fakeDb = {
      transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(fakeDb),
      execute: vi.fn(async () => []),
      select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }),
      insert: () => ({ values: vi.fn(async () => undefined) }),
    };
    const result = await recoverFeedbackHistoryCommand(io, {
      repo: 'almondoo/review-agent',
      installationId: 1n,
      env: { DATABASE_URL: 'postgres://x' } as NodeJS.ProcessEnv,
      platform: 'codecommit',
      dryRun: true,
      codecommitClient,
      // biome-ignore lint/suspicious/noExplicitAny: stubbed DB client
      createDb: () => ({ db: fakeDb as any, close }),
    });
    expect(result.status).toBe('ok');
    expect(result.candidates).toBe(0);
    expect(io.out.join('')).toContain('codecommit re-scrape');
    expect(io.out.join('')).toContain('0 resolved');
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('errors out without DATABASE_URL', async () => {
    const io = recordingIo();
    const result = await recoverFeedbackHistoryCommand(io, {
      repo: 'almondoo/review-agent',
      installationId: 1n,
      env: {} as NodeJS.ProcessEnv,
      platform: 'github',
      candidatesFile: '/tmp/x.jsonl',
    });
    expect(result.status).toBe('ok');
    expect(io.err.join('')).toContain('DATABASE_URL is required');
  });

  it('parses JSONL candidates and reports counts (dry-run uses the createDb seam)', async () => {
    const io = recordingIo();
    const candidatesJsonl =
      '{"factType":"rejected_finding","factText":"[fp:abc] one"}\n' +
      '// comment line — operator note\n' +
      '\n' +
      '{"factType":"accepted_pattern","factText":"[fp:def] two"}\n';
    const close = vi.fn(async () => undefined);
    const fakeDb = {
      transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(fakeDb),
      execute: vi.fn(async () => []),
      select: () => ({
        from: () => ({
          where: () => Promise.resolve([]),
        }),
      }),
      insert: () => ({ values: vi.fn(async () => undefined) }),
    };
    const result = await recoverFeedbackHistoryCommand(io, {
      repo: 'almondoo/review-agent',
      installationId: 7n,
      env: { DATABASE_URL: 'postgres://x' } as NodeJS.ProcessEnv,
      platform: 'github',
      candidatesFile: '/tmp/x.jsonl',
      dryRun: true,
      readFile: async () => candidatesJsonl,
      // biome-ignore lint/suspicious/noExplicitAny: stubbed DB client shape
      createDb: () => ({ db: fakeDb as any, close }),
    });
    expect(result.status).toBe('ok');
    // 2 candidates parsed (the comment + blank line are skipped).
    expect(result.candidates).toBe(2);
    // dry-run reports skippedExisting = candidates - fresh; with no
    // existing rows we keep all as fresh-but-not-inserted.
    expect(result.recovered).toBe(0);
    expect(io.out.join('')).toContain('candidates=2');
    expect(io.out.join('')).toContain('dry-run; no inserts');
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed JSONL with a clear error', async () => {
    const io = recordingIo();
    await expect(() =>
      recoverFeedbackHistoryCommand(io, {
        repo: 'almondoo/review-agent',
        installationId: 7n,
        env: { DATABASE_URL: 'postgres://x' } as NodeJS.ProcessEnv,
        platform: 'github',
        candidatesFile: '/tmp/bad.jsonl',
        readFile: async () => '{"factType":"unknown","factText":"x"}\n',
        createDb: () => ({
          // biome-ignore lint/suspicious/noExplicitAny: not reached
          db: {} as any,
          close: async () => undefined,
        }),
      }),
    ).rejects.toThrow(/Invalid factType/);
  });
});
