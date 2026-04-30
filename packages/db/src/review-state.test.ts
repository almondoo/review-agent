import type { ReviewState } from '@review-agent/core';
import { describe, expect, it, vi } from 'vitest';
import { loadReviewState } from './review-state.js';

const stateA: ReviewState = {
  schemaVersion: 1,
  lastReviewedSha: 'a',
  baseSha: 'b',
  reviewedAt: '2026-04-30T00:00:00Z',
  modelUsed: 'm',
  totalTokens: 0,
  totalCostUsd: 0,
  commentFingerprints: [],
};

const stateB: ReviewState = {
  ...stateA,
  reviewedAt: '2026-04-30T00:01:00Z',
};

describe('loadReviewState', () => {
  it('returns mirror state when both agree', async () => {
    const upsert = vi.fn();
    const r = await loadReviewState(
      { fromMirror: async () => stateA, fromHiddenComment: async () => stateA },
      upsert,
    );
    expect(r).toBe(stateA);
    expect(upsert).not.toHaveBeenCalled();
  });

  it('returns mirror when hidden comment is null', async () => {
    const upsert = vi.fn();
    const r = await loadReviewState(
      { fromMirror: async () => stateA, fromHiddenComment: async () => null },
      upsert,
    );
    expect(r).toBe(stateA);
    expect(upsert).not.toHaveBeenCalled();
  });

  it('returns hidden + writes mirror when mirror is missing', async () => {
    const upsert = vi.fn().mockResolvedValue(undefined);
    const r = await loadReviewState(
      { fromMirror: async () => null, fromHiddenComment: async () => stateA },
      upsert,
    );
    expect(r).toBe(stateA);
    expect(upsert).toHaveBeenCalledWith(stateA, 'a');
  });

  it('hidden comment wins on conflict and updates mirror (§12.1)', async () => {
    const upsert = vi.fn().mockResolvedValue(undefined);
    const r = await loadReviewState(
      { fromMirror: async () => stateA, fromHiddenComment: async () => stateB },
      upsert,
    );
    expect(r).toBe(stateB);
    expect(upsert).toHaveBeenCalledOnce();
  });

  it('returns null when both sources are empty', async () => {
    const upsert = vi.fn();
    const r = await loadReviewState(
      { fromMirror: async () => null, fromHiddenComment: async () => null },
      upsert,
    );
    expect(r).toBeNull();
    expect(upsert).not.toHaveBeenCalled();
  });
});
