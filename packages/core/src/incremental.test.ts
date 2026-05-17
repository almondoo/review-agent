import { describe, expect, it, vi } from 'vitest';
import {
  classifyGitError,
  computeDiffStrategy,
  type IncrementalGitFailure,
  shiftLineThroughHunks,
} from './incremental.js';
import type { ReviewState } from './review.js';

function makeState(overrides: Partial<ReviewState> = {}): ReviewState {
  return {
    schemaVersion: 1,
    lastReviewedSha: 'prevHead',
    baseSha: 'prevBase',
    reviewedAt: '2026-04-29T00:00:00Z',
    modelUsed: 'm',
    totalTokens: 0,
    totalCostUsd: 0,
    commentFingerprints: [],
    ...overrides,
  };
}

describe('computeDiffStrategy', () => {
  it('returns full when no prior state', async () => {
    const r = await computeDiffStrategy('/ws', null, { baseSha: 'b', headSha: 'h' });
    expect(r).toBe('full');
  });

  it('returns full when prevState lacks head/base sha', async () => {
    const state = makeState({ lastReviewedSha: '', baseSha: '' });
    const r = await computeDiffStrategy('/ws', state, { baseSha: 'b', headSha: 'h' });
    expect(r).toBe('full');
  });

  it('returns full when previous merge-base shifts (rebase)', async () => {
    const runGit = vi.fn(async (_w: string, args: ReadonlyArray<string>) => {
      const [cmd, a, b] = args;
      if (cmd !== 'merge-base') throw new Error('unexpected');
      if (a === 'prevBase' && b === 'prevHead') return 'old-mb';
      if (a === 'newBase' && b === 'newHead') return 'new-mb';
      return 'ignored';
    });
    const r = await computeDiffStrategy(
      '/ws',
      makeState(),
      { baseSha: 'newBase', headSha: 'newHead' },
      { runGit },
    );
    expect(r).toBe('full');
  });

  it('returns full when prev head no longer reachable from current head', async () => {
    const runGit = vi.fn(async (_w: string, args: ReadonlyArray<string>) => {
      const [cmd, a, b] = args;
      if (cmd !== 'merge-base') throw new Error('unexpected');
      if (a === 'prevBase' && b === 'prevHead') return 'mb-1';
      if (a === 'newBase' && b === 'newHead') return 'mb-1';
      // unreachable: returns something other than the prev head
      return 'orphan';
    });
    const r = await computeDiffStrategy(
      '/ws',
      makeState(),
      { baseSha: 'newBase', headSha: 'newHead' },
      { runGit },
    );
    expect(r).toBe('full');
  });

  it('returns incremental since prev head when reachable and merge-base unchanged', async () => {
    const runGit = vi.fn(async (_w: string, args: ReadonlyArray<string>) => {
      const [cmd, a, b] = args;
      if (cmd !== 'merge-base') throw new Error('unexpected');
      if (a === 'prevBase' && b === 'prevHead') return 'mb-1';
      if (a === 'newBase' && b === 'newHead') return 'mb-1';
      if (a === 'prevHead') return 'prevHead';
      return 'ignored';
    });
    const r = await computeDiffStrategy(
      '/ws',
      makeState(),
      { baseSha: 'newBase', headSha: 'newHead' },
      { runGit },
    );
    expect(r).toEqual({ since: 'prevHead' });
  });

  it('returns full on git error during merge-base (permanent: unknown revision)', async () => {
    const runGit = vi
      .fn()
      .mockRejectedValue(new Error('git merge-base prev curr failed (128): bad revision'));
    const failures: IncrementalGitFailure[] = [];
    const r = await computeDiffStrategy(
      '/ws',
      makeState(),
      { baseSha: 'b', headSha: 'h' },
      {
        runGit,
        onGitFailure: (f) => failures.push(f),
      },
    );
    expect(r).toBe('full');
    expect(failures.length).toBeGreaterThanOrEqual(1);
    for (const f of failures) {
      expect(f.reason).toBe('permanent');
      expect(f.retried).toBe(false);
      expect(f.args[0]).toBe('merge-base');
    }
    // permanent classification MUST NOT trigger a retry — operator
    // visibility budgets depend on it.
    expect(runGit).toHaveBeenCalledTimes(2);
  });

  it('classifies auth errors and reports them via onGitFailure (no retry)', async () => {
    const authMessage =
      'git merge-base prev curr failed (128): fatal: Authentication failed for https://github.com/o/r';
    const runGit = vi.fn().mockRejectedValue(new Error(authMessage));
    const failures: IncrementalGitFailure[] = [];
    const delay = vi.fn(async () => undefined);
    const r = await computeDiffStrategy(
      '/ws',
      makeState(),
      { baseSha: 'b', headSha: 'h' },
      {
        runGit,
        onGitFailure: (f) => failures.push(f),
        delayMs: delay,
      },
    );
    expect(r).toBe('full');
    expect(delay).not.toHaveBeenCalled();
    expect(failures.length).toBeGreaterThanOrEqual(1);
    for (const f of failures) {
      expect(f.reason).toBe('auth');
      expect(f.retried).toBe(false);
      expect(f.message).toContain('Authentication failed');
    }
    // Auth = exactly one call per merge-base invocation (no retry).
    // 2 mergeBase calls happen before reachability since rebase-check is
    // first; once those return null, the function returns 'full' without
    // running the reachability check.
    expect(runGit).toHaveBeenCalledTimes(2);
  });

  it('retries once on transient error and returns incremental when retry succeeds', async () => {
    const transient = new Error(
      'git merge-base prev curr failed (null): could not resolve host github.com',
    );
    let calls = 0;
    const runGit = vi.fn(async (_w: string, args: ReadonlyArray<string>) => {
      const [cmd, a, b] = args;
      if (cmd !== 'merge-base') throw new Error('unexpected');
      // Fail the very first invocation (prevBase, prevHead) once, then
      // recover on retry. All later calls succeed normally.
      if (a === 'prevBase' && b === 'prevHead') {
        calls += 1;
        if (calls === 1) throw transient;
        return 'mb-1';
      }
      if (a === 'newBase' && b === 'newHead') return 'mb-1';
      if (a === 'prevHead') return 'prevHead';
      return 'ignored';
    });
    const failures: IncrementalGitFailure[] = [];
    const delay = vi.fn(async () => undefined);
    const r = await computeDiffStrategy(
      '/ws',
      makeState(),
      { baseSha: 'newBase', headSha: 'newHead' },
      {
        runGit,
        onGitFailure: (f) => failures.push(f),
        delayMs: delay,
      },
    );
    expect(r).toEqual({ since: 'prevHead' });
    // Retry happened with a backoff sleep, and recovery was silent
    // (no `onGitFailure` event because the second attempt succeeded).
    expect(delay).toHaveBeenCalledTimes(1);
    expect(failures).toHaveLength(0);
  });

  it('emits onGitFailure with retried=true when transient retry also fails', async () => {
    const transient = new Error('git merge-base prev curr failed (null): network is unreachable');
    const runGit = vi.fn().mockRejectedValue(transient);
    const failures: IncrementalGitFailure[] = [];
    const delay = vi.fn(async () => undefined);
    const r = await computeDiffStrategy(
      '/ws',
      makeState(),
      { baseSha: 'b', headSha: 'h' },
      {
        runGit,
        onGitFailure: (f) => failures.push(f),
        delayMs: delay,
      },
    );
    expect(r).toBe('full');
    // Two parallel mergeBase calls happen for the rebase check; each
    // retries once → 4 runGit invocations, 2 delays.
    expect(runGit).toHaveBeenCalledTimes(4);
    expect(delay).toHaveBeenCalledTimes(2);
    expect(failures.length).toBeGreaterThanOrEqual(1);
    for (const f of failures) {
      expect(f.reason).toBe('transient');
      expect(f.retried).toBe(true);
    }
  });

  it('tolerates non-Error rejection values (string thrown)', async () => {
    const runGit = vi.fn().mockRejectedValue('not an Error instance');
    const failures: IncrementalGitFailure[] = [];
    const r = await computeDiffStrategy(
      '/ws',
      makeState(),
      { baseSha: 'b', headSha: 'h' },
      {
        runGit,
        onGitFailure: (f) => failures.push(f),
      },
    );
    expect(r).toBe('full');
    expect(failures[0]?.message).toBe('not an Error instance');
  });
});

describe('classifyGitError', () => {
  it('detects auth patterns (Permission denied)', () => {
    expect(classifyGitError('fatal: Permission denied (publickey)')).toBe('auth');
  });

  it('detects auth patterns (Authentication failed)', () => {
    expect(classifyGitError('fatal: Authentication failed for https://...')).toBe('auth');
  });

  it('detects auth patterns (could not read from remote / unable to access)', () => {
    expect(classifyGitError('fatal: Could not read from remote repository.')).toBe('auth');
    expect(classifyGitError('fatal: unable to access https://github.com/o/r')).toBe('auth');
  });

  it('detects auth patterns (Host key verification failed)', () => {
    expect(classifyGitError('Host key verification failed.')).toBe('auth');
  });

  it('detects auth patterns (HTTP 401/403)', () => {
    expect(classifyGitError('error: RPC failed; HTTP/1.1 401 Unauthorized')).toBe('auth');
    expect(classifyGitError('error: RPC failed; HTTP/2 403 Forbidden')).toBe('auth');
  });

  it('detects transient patterns (timeout / could not resolve host / network unreachable)', () => {
    expect(classifyGitError('error: ssh: connect to host x.com: Operation timed out')).toBe(
      'transient',
    );
    // When the message includes BOTH "unable to access" (auth) and
    // "could not resolve host" (transient), auth wins because auth
    // patterns are checked first — this is intentional: a 401 served
    // *via* a flaky resolver is still an auth problem.
    expect(
      classifyGitError(
        "fatal: unable to access 'https://github.com/o/r/': Could not resolve host: github.com",
      ),
    ).toBe('auth');
    expect(classifyGitError('could not resolve host github.com')).toBe('transient');
    expect(classifyGitError('Network is unreachable')).toBe('transient');
    expect(classifyGitError('Connection reset by peer')).toBe('transient');
    expect(classifyGitError('Connection refused')).toBe('transient');
  });

  it('detects transient patterns (spawn timeout: failed (null))', () => {
    // The defaultRunGit reports SIGTERM-killed processes as `(null)`.
    expect(
      classifyGitError('git merge-base prev curr failed (null): process killed by timeout'),
    ).toBe('transient');
  });

  it('falls back to permanent for unrecognised messages', () => {
    expect(classifyGitError('fatal: bad revision deadbeef')).toBe('permanent');
    expect(classifyGitError('fatal: Not a valid object name')).toBe('permanent');
    expect(classifyGitError('boom')).toBe('permanent');
    expect(classifyGitError('')).toBe('permanent');
  });
});

describe('shiftLineThroughHunks', () => {
  it('returns the same line when no hunks affect it', () => {
    expect(
      shiftLineThroughHunks(50, [{ oldStart: 100, oldLines: 2, newStart: 100, newLines: 2 }]),
    ).toBe(50);
  });

  it('shifts down when lines were added above', () => {
    expect(
      shiftLineThroughHunks(50, [{ oldStart: 10, oldLines: 0, newStart: 10, newLines: 5 }]),
    ).toBe(55);
  });

  it('shifts up when lines were deleted above', () => {
    expect(
      shiftLineThroughHunks(50, [{ oldStart: 10, oldLines: 3, newStart: 10, newLines: 0 }]),
    ).toBe(47);
  });

  it('returns null when the line itself was deleted', () => {
    expect(
      shiftLineThroughHunks(12, [{ oldStart: 10, oldLines: 5, newStart: 10, newLines: 0 }]),
    ).toBeNull();
  });

  it('maps inside a modified hunk proportionally when new lines exist', () => {
    expect(
      shiftLineThroughHunks(11, [{ oldStart: 10, oldLines: 5, newStart: 100, newLines: 5 }]),
    ).toBe(101);
  });

  it('handles multiple hunks compounding offsets', () => {
    const hunks = [
      { oldStart: 5, oldLines: 0, newStart: 5, newLines: 3 },
      { oldStart: 30, oldLines: 2, newStart: 33, newLines: 0 },
    ];
    expect(shiftLineThroughHunks(50, hunks)).toBe(51);
  });

  it('maps the last line inside a hunk (oldStart + oldLines - 1)', () => {
    // Boundary: originalLine == oldEnd. The branch at incremental.ts:96
    // (`originalLine <= oldEnd`) is the off-by-one risk.
    expect(
      shiftLineThroughHunks(14, [{ oldStart: 10, oldLines: 5, newStart: 100, newLines: 5 }]),
    ).toBe(104);
  });

  it('returns null when the last hunk line is deleted (newLines === 0 inside hunk)', () => {
    // oldEnd = 14 with newLines: 0 → entire range deleted, including the boundary.
    expect(
      shiftLineThroughHunks(14, [{ oldStart: 10, oldLines: 5, newStart: 10, newLines: 0 }]),
    ).toBeNull();
  });

  it('returns null when originalLine is inside hunk but offset >= newLines', () => {
    // hunk shrinks: 5 old lines → 2 new lines. Lines 10–11 map; 12–14 are dropped.
    expect(
      shiftLineThroughHunks(13, [{ oldStart: 10, oldLines: 5, newStart: 50, newLines: 2 }]),
    ).toBeNull();
  });
});
