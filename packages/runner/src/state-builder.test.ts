import type { InlineComment, ReviewState } from '@review-agent/core';
import { describe, expect, it } from 'vitest';
import { buildReviewState } from './state-builder.js';

const comment = (overrides: Partial<InlineComment> = {}): InlineComment => ({
  path: 'src/a.ts',
  line: 1,
  side: 'RIGHT',
  body: 'note',
  fingerprint: 'fp1',
  severity: 'info',
  ...overrides,
});

const previous: ReviewState = {
  schemaVersion: 1,
  lastReviewedSha: 'old',
  baseSha: 'b',
  reviewedAt: '2026-04-01T00:00:00Z',
  modelUsed: 'm',
  totalTokens: 1000,
  totalCostUsd: 0.05,
  commentFingerprints: ['fp-existing'],
};

describe('buildReviewState', () => {
  it('produces a v1 state with current head/base', () => {
    const state = buildReviewState({
      previousState: null,
      comments: [comment()],
      headSha: 'head',
      baseSha: 'base',
      modelUsed: 'claude-sonnet-4-6',
      tokensUsed: 500,
      costUsd: 0.02,
    });
    expect(state.schemaVersion).toBe(1);
    expect(state.lastReviewedSha).toBe('head');
    expect(state.baseSha).toBe('base');
    expect(state.modelUsed).toBe('claude-sonnet-4-6');
    expect(state.totalTokens).toBe(500);
    expect(state.totalCostUsd).toBeCloseTo(0.02);
  });

  it('merges fingerprints with previous state and dedups', () => {
    const state = buildReviewState({
      previousState: previous,
      comments: [comment({ fingerprint: 'fp-new' }), comment({ fingerprint: 'fp-existing' })],
      headSha: 'h',
      baseSha: 'b',
      modelUsed: 'm',
      tokensUsed: 100,
      costUsd: 0.01,
    });
    expect(state.commentFingerprints).toEqual(['fp-existing', 'fp-new']);
  });

  it('accumulates totalTokens and totalCostUsd', () => {
    const state = buildReviewState({
      previousState: previous,
      comments: [],
      headSha: 'h',
      baseSha: 'b',
      modelUsed: 'm',
      tokensUsed: 250,
      costUsd: 0.01,
    });
    expect(state.totalTokens).toBe(1250);
    expect(state.totalCostUsd).toBeCloseTo(0.06);
  });

  it('uses ISO timestamp for reviewedAt', () => {
    const state = buildReviewState({
      previousState: null,
      comments: [],
      headSha: 'h',
      baseSha: 'b',
      modelUsed: 'm',
      tokensUsed: 0,
      costUsd: 0,
    });
    expect(state.reviewedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});
