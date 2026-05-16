import type { ReviewState, VCS } from '@review-agent/core';
import { describe, expect, it, vi } from 'vitest';
import { recoverSyncStateCommand } from './recover.js';

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
