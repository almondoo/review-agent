import { describe, expect, it, vi } from 'vitest';
import { computeDiffStrategy, shiftLineThroughHunks } from './incremental.js';
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

  it('returns full on git error during merge-base', async () => {
    const runGit = vi.fn().mockRejectedValue(new Error('boom'));
    const r = await computeDiffStrategy(
      '/ws',
      makeState(),
      { baseSha: 'b', headSha: 'h' },
      { runGit },
    );
    expect(r).toBe('full');
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
});
