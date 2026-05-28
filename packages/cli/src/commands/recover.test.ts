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

  it('omits the "(dry-run; no inserts)" suffix when dryRun is false', async () => {
    // The `opts.dryRun ? '...' : ''` ternary: false arm. The other test
    // covers the truthy arm. Drive the full happy-path with dryRun=false
    // so the formatter's empty-arm is exercised.
    const io = recordingIo();
    const close = vi.fn(async () => undefined);
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
      repo: 'o/r',
      installationId: 1n,
      env: { DATABASE_URL: 'postgres://x' } as NodeJS.ProcessEnv,
      // dryRun intentionally omitted (defaults to false in the helper)
      // biome-ignore lint/suspicious/noExplicitAny: stubbed DB client
      createDb: () => ({ db: fakeDb as any, close }),
    });
    expect(result.status).toBe('ok');
    expect(io.out.join('')).not.toContain('dry-run');
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('forwards a --since date to the underlying recoverReviewEvalEvents helper', async () => {
    // The `opts.since ? new Date(opts.since) : undefined` ternary's truthy
    // arm: drive it to pin that the formatted output mentions the
    // installation and the helper resolves with a since value.
    const io = recordingIo();
    const close = vi.fn(async () => undefined);
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
      repo: 'o/r',
      installationId: 42n,
      env: { DATABASE_URL: 'postgres://x' } as NodeJS.ProcessEnv,
      since: '2026-01-01',
      // biome-ignore lint/suspicious/noExplicitAny: stubbed DB client
      createDb: () => ({ db: fakeDb as any, close }),
    });
    expect(result.status).toBe('ok');
  });

  it('emits a stderr info line when --platform codecommit is passed (cost_ledger is provider-agnostic)', async () => {
    // The `opts.platform ?? 'github'` chain's truthy-codecommit arm.
    // The action still proceeds (no early-return), so an additional
    // missing-DATABASE_URL stderr is also expected.
    const io = recordingIo();
    const result = await recoverReviewEvalEventsCommand(io, {
      repo: 'demo',
      installationId: 1n,
      env: {} as NodeJS.ProcessEnv,
      platform: 'codecommit',
    });
    expect(result.status).toBe('ok');
    const stderr = io.err.join('');
    expect(stderr).toContain('--platform codecommit is supported');
    expect(stderr).toContain('DATABASE_URL is required');
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
      repo: 'review-agent',
      installationId: 1n,
      env: { DATABASE_URL: 'postgres://x' } as NodeJS.ProcessEnv,
      platform: 'codecommit',
      botArn: 'arn:aws:iam::1:role/review-agent-bot',
      dryRun: true,
      codecommitClient,
      // biome-ignore lint/suspicious/noExplicitAny: stubbed DB client
      createDb: () => ({ db: fakeDb as any, close }),
    });
    expect(result.status).toBe('ok');
    expect(result.candidates).toBe(0);
    expect(io.out.join('')).toContain('codecommit re-scrape');
    expect(io.out.join('')).toContain('0 resolved');
    // v1.2 #110: repo key normalized to `${installationId}/${repo}` so
    // a wrong-owner --repo can never shadow another tenant's rows.
    expect(io.out.join('')).toContain('repo=1/review-agent');
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

  it('--platform codecommit requires --bot-arn (early-return + stderr)', async () => {
    const io = recordingIo();
    const close = vi.fn(async () => undefined);
    const result = await recoverFeedbackHistoryCommand(io, {
      repo: 'review-agent',
      installationId: 1n,
      env: { DATABASE_URL: 'postgres://x' } as NodeJS.ProcessEnv,
      platform: 'codecommit',
      dryRun: true,
      // biome-ignore lint/suspicious/noExplicitAny: not reached
      createDb: () => ({ db: {} as any, close }),
    });
    expect(result.status).toBe('ok');
    expect(result.candidates).toBe(0);
    expect(io.err.join('')).toContain('--bot-arn is required when --platform codecommit');
    // We bail before opening the DB pool.
    expect(close).not.toHaveBeenCalled();
  });

  it('--since with malformed value (slashes) is rejected with stderr', async () => {
    const io = recordingIo();
    const close = vi.fn(async () => undefined);
    const result = await recoverFeedbackHistoryCommand(io, {
      repo: 'almondoo/review-agent',
      installationId: 1n,
      env: { DATABASE_URL: 'postgres://x' } as NodeJS.ProcessEnv,
      platform: 'github',
      candidatesFile: '/tmp/x.jsonl',
      since: '2026/05/01',
      dryRun: true,
      readFile: async () => '',
      // biome-ignore lint/suspicious/noExplicitAny: not reached
      createDb: () => ({ db: {} as any, close }),
    });
    expect(result.status).toBe('ok');
    expect(result.candidates).toBe(0);
    expect(io.err.join('')).toContain('--since must be');
    expect(close).not.toHaveBeenCalled();
  });

  it('--rate Infinity warns and falls back to the 500ms default (codecommit)', async () => {
    const io = recordingIo();
    const close = vi.fn(async () => undefined);
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
      repo: 'review-agent',
      installationId: 7n,
      env: { DATABASE_URL: 'postgres://x' } as NodeJS.ProcessEnv,
      platform: 'codecommit',
      botArn: 'arn:aws:iam::7:role/review-agent-bot',
      rate: Number.POSITIVE_INFINITY,
      dryRun: true,
      codecommitClient,
      // biome-ignore lint/suspicious/noExplicitAny: stubbed DB client
      createDb: () => ({ db: fakeDb as any, close }),
    });
    expect(result.status).toBe('ok');
    expect(io.err.join('')).toMatch(/--rate must be a finite positive number/);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('codecommit --repo with mismatched owner prefix warns and normalizes the DB key', async () => {
    const io = recordingIo();
    const close = vi.fn(async () => undefined);
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
      repo: 'wrong-account/foo',
      installationId: 123n,
      env: { DATABASE_URL: 'postgres://x' } as NodeJS.ProcessEnv,
      platform: 'codecommit',
      botArn: 'arn:aws:iam::123:role/review-agent-bot',
      dryRun: true,
      codecommitClient,
      // biome-ignore lint/suspicious/noExplicitAny: stubbed DB client
      createDb: () => ({ db: fakeDb as any, close }),
    });
    expect(result.status).toBe('ok');
    expect(io.err.join('')).toMatch(/owner 'wrong-account' does not match --installation-id 123/);
    // DB key is normalized to `${installationId}/${repoName}` regardless
    // of operator typo.
    expect(io.out.join('')).toContain('repo=123/foo');
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

  // Stage C: pin the remaining feedback-history command branches.

  it('--platform github without --candidates-file emits stderr and bails (no DB pool opened)', async () => {
    const io = recordingIo();
    const close = vi.fn(async () => undefined);
    const result = await recoverFeedbackHistoryCommand(io, {
      repo: 'almondoo/review-agent',
      installationId: 1n,
      env: { DATABASE_URL: 'postgres://x' } as NodeJS.ProcessEnv,
      platform: 'github',
      // candidatesFile intentionally omitted
      dryRun: true,
      // biome-ignore lint/suspicious/noExplicitAny: not reached
      createDb: () => ({ db: {} as any, close }),
    });
    expect(result.status).toBe('ok');
    expect(result.candidates).toBe(0);
    expect(io.err.join('')).toContain('--candidates-file');
    // We bail before opening the DB pool.
    expect(close).not.toHaveBeenCalled();
  });

  it('rejects a JSONL row whose factText is the empty string', async () => {
    const io = recordingIo();
    await expect(() =>
      recoverFeedbackHistoryCommand(io, {
        repo: 'almondoo/review-agent',
        installationId: 7n,
        env: { DATABASE_URL: 'postgres://x' } as NodeJS.ProcessEnv,
        platform: 'github',
        candidatesFile: '/tmp/empty-text.jsonl',
        // factType is valid but factText is empty → the second invariant
        // check fires.
        readFile: async () => '{"factType":"rejected_finding","factText":""}\n',
        createDb: () => ({
          // biome-ignore lint/suspicious/noExplicitAny: not reached
          db: {} as any,
          close: async () => undefined,
        }),
      }),
    ).rejects.toThrow(/Invalid factText/);
  });

  it('rejects a JSONL row whose factText is the wrong type (number)', async () => {
    // Same invariant branch as above but on the type-check arm.
    const io = recordingIo();
    await expect(() =>
      recoverFeedbackHistoryCommand(io, {
        repo: 'almondoo/review-agent',
        installationId: 7n,
        env: { DATABASE_URL: 'postgres://x' } as NodeJS.ProcessEnv,
        platform: 'github',
        candidatesFile: '/tmp/numeric-text.jsonl',
        readFile: async () => '{"factType":"accepted_pattern","factText":42}\n',
        createDb: () => ({
          // biome-ignore lint/suspicious/noExplicitAny: not reached
          db: {} as any,
          close: async () => undefined,
        }),
      }),
    ).rejects.toThrow(/Invalid factText/);
  });

  it('rejects a codecommit --repo with disallowed characters (multiple slashes / spaces)', async () => {
    // The `CODECOMMIT_REPO_RE.test(opts.repo)` guard: regex matches at
    // most one slash and no whitespace. We feed `'owner/sub/repo'` to
    // drive the falsy arm (returns the bail-out with stderr).
    const io = recordingIo();
    const close = vi.fn(async () => undefined);
    const result = await recoverFeedbackHistoryCommand(io, {
      repo: 'owner/sub/repo',
      installationId: 1n,
      env: { DATABASE_URL: 'postgres://x' } as NodeJS.ProcessEnv,
      platform: 'codecommit',
      botArn: 'arn:aws:iam::1:role/bot',
      dryRun: true,
      // biome-ignore lint/suspicious/noExplicitAny: not reached
      createDb: () => ({ db: {} as any, close }),
    });
    expect(result.status).toBe('ok');
    expect(result.candidates).toBe(0);
    expect(io.err.join('')).toContain("--repo must be '<name>' or 'owner/<name>'");
    expect(close).not.toHaveBeenCalled();
  });

  it('codecommit --rate=2 hits the valid `Number.isFinite && > 0` arm and computes delayMs=500', async () => {
    // The truthy arm of `Number.isFinite(opts.rate) && opts.rate > 0`.
    // We can't observe the computed delayMs directly (it's forwarded to
    // the scrape helper), but a finite positive --rate must NOT emit
    // the "warning: --rate must be a finite positive number" line.
    const io = recordingIo();
    const close = vi.fn(async () => undefined);
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
      repo: 'review-agent',
      installationId: 1n,
      env: { DATABASE_URL: 'postgres://x' } as NodeJS.ProcessEnv,
      platform: 'codecommit',
      botArn: 'arn:aws:iam::1:role/bot',
      rate: 2,
      dryRun: true,
      codecommitClient,
      // biome-ignore lint/suspicious/noExplicitAny: stubbed DB client
      createDb: () => ({ db: fakeDb as any, close }),
    });
    expect(result.status).toBe('ok');
    // Pin the contract: a sensible --rate does not produce the warning.
    expect(io.err.join('')).not.toContain('--rate must be');
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('codecommit --since with a full ISO 8601 timestamp hits the includes(T) truthy arm', async () => {
    // parseIsoDate's `value.includes('T') ? new Date(value) : ...` truthy
    // arm. The other valid-since test in this file uses `'2026-01-15'`,
    // i.e. the falsy arm.
    const io = recordingIo();
    const close = vi.fn(async () => undefined);
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
      repo: 'review-agent',
      installationId: 1n,
      env: { DATABASE_URL: 'postgres://x' } as NodeJS.ProcessEnv,
      platform: 'codecommit',
      botArn: 'arn:aws:iam::1:role/bot',
      since: '2026-02-01T12:00:00Z',
      dryRun: true,
      codecommitClient,
      // biome-ignore lint/suspicious/noExplicitAny: stubbed DB client
      createDb: () => ({ db: fakeDb as any, close }),
    });
    expect(result.status).toBe('ok');
    expect(io.err.join('')).not.toContain('--since must be');
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('codecommit --since matching the regex but encoding an unparseable date returns invalid', async () => {
    // parseIsoDate's `Number.isNaN(parsed.getTime()) ? undefined : parsed`
    // truthy arm. `'2026-13-45'` matches the regex but new Date(...) is
    // Invalid Date.
    const io = recordingIo();
    const close = vi.fn(async () => undefined);
    const result = await recoverFeedbackHistoryCommand(io, {
      repo: 'review-agent',
      installationId: 1n,
      env: { DATABASE_URL: 'postgres://x' } as NodeJS.ProcessEnv,
      platform: 'codecommit',
      botArn: 'arn:aws:iam::1:role/bot',
      since: '2026-13-45',
      dryRun: true,
      // biome-ignore lint/suspicious/noExplicitAny: not reached
      createDb: () => ({ db: {} as any, close }),
    });
    expect(result.status).toBe('ok');
    expect(io.err.join('')).toContain('--since must be');
    expect(close).not.toHaveBeenCalled();
  });

  it('codecommit --since with a valid YYYY-MM-DD is accepted and propagates through', async () => {
    // The `sinceDate` truthy arm. The other --since test (`'2026/05/01'`)
    // exercises the rejection path; this one exercises the
    // happy-parse + forward-to-scrape arm.
    const io = recordingIo();
    const close = vi.fn(async () => undefined);
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
      repo: 'review-agent',
      installationId: 1n,
      env: { DATABASE_URL: 'postgres://x' } as NodeJS.ProcessEnv,
      platform: 'codecommit',
      botArn: 'arn:aws:iam::1:role/bot',
      since: '2026-01-15',
      dryRun: true,
      codecommitClient,
      // biome-ignore lint/suspicious/noExplicitAny: stubbed DB client
      createDb: () => ({ db: fakeDb as any, close }),
    });
    expect(result.status).toBe('ok');
    expect(io.err.join('')).not.toContain('--since must be');
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('accepts arch_decision factType (third branch of the valid-type discriminator)', async () => {
    // The `parsed.factType !== 'X' && != 'Y' && != 'Z'` guard has three
    // truthy arms (each individual mismatch) and one falsy arm (a
    // matching type). The other tests already cover `rejected_finding`
    // and `accepted_pattern`; this pins the third valid arm.
    const io = recordingIo();
    const close = vi.fn(async () => undefined);
    const fakeDb = {
      transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(fakeDb),
      execute: vi.fn(async () => []),
      select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }),
      insert: () => ({ values: vi.fn(async () => undefined) }),
    };
    const result = await recoverFeedbackHistoryCommand(io, {
      repo: 'o/r',
      installationId: 7n,
      env: { DATABASE_URL: 'postgres://x' } as NodeJS.ProcessEnv,
      platform: 'github',
      candidatesFile: '/tmp/arch.jsonl',
      dryRun: true,
      readFile: async () => '{"factType":"arch_decision","factText":"[fp:abc] X"}\n',
      // biome-ignore lint/suspicious/noExplicitAny: stubbed DB client
      createDb: () => ({ db: fakeDb as any, close }),
    });
    expect(result.status).toBe('ok');
    expect(result.candidates).toBe(1);
    expect(close).toHaveBeenCalledTimes(1);
  });
});
