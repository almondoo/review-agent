import { describe, expect, it } from 'vitest';
import { computeReviewEvent, type InlineComment } from './review.js';

function makeComment(overrides: Partial<InlineComment> = {}): InlineComment {
  return {
    path: 'src/x.ts',
    line: 1,
    side: 'RIGHT',
    body: 'body',
    fingerprint: '0123456789abcdef',
    severity: 'minor',
    ...overrides,
  };
}

describe('computeReviewEvent', () => {
  it('returns COMMENT for an empty comment list regardless of threshold', () => {
    expect(computeReviewEvent([], 'critical')).toBe('COMMENT');
    expect(computeReviewEvent([], 'major')).toBe('COMMENT');
    expect(computeReviewEvent([], 'never')).toBe('COMMENT');
  });

  it('threshold=critical → REQUEST_CHANGES only when a critical is present', () => {
    expect(computeReviewEvent([makeComment({ severity: 'critical' })], 'critical')).toBe(
      'REQUEST_CHANGES',
    );
    expect(computeReviewEvent([makeComment({ severity: 'major' })], 'critical')).toBe('COMMENT');
    expect(computeReviewEvent([makeComment({ severity: 'minor' })], 'critical')).toBe('COMMENT');
    expect(computeReviewEvent([makeComment({ severity: 'info' })], 'critical')).toBe('COMMENT');
  });

  it('threshold=major → REQUEST_CHANGES on critical OR major', () => {
    expect(computeReviewEvent([makeComment({ severity: 'critical' })], 'major')).toBe(
      'REQUEST_CHANGES',
    );
    expect(computeReviewEvent([makeComment({ severity: 'major' })], 'major')).toBe(
      'REQUEST_CHANGES',
    );
    expect(computeReviewEvent([makeComment({ severity: 'minor' })], 'major')).toBe('COMMENT');
    expect(computeReviewEvent([makeComment({ severity: 'info' })], 'major')).toBe('COMMENT');
  });

  it('threshold=never → always COMMENT even when criticals are present', () => {
    expect(
      computeReviewEvent(
        [makeComment({ severity: 'critical' }), makeComment({ line: 2, severity: 'major' })],
        'never',
      ),
    ).toBe('COMMENT');
  });

  it('a single critical anywhere in the list flips the event under threshold=critical', () => {
    // Pin the early-exit invariant: the function should not depend
    // on the critical being first or last.
    const middle = [
      makeComment({ severity: 'minor' }),
      makeComment({ line: 2, severity: 'critical' }),
      makeComment({ line: 3, severity: 'info' }),
    ];
    expect(computeReviewEvent(middle, 'critical')).toBe('REQUEST_CHANGES');
  });

  it('never returns APPROVE — even with an empty comment list and threshold=never', () => {
    // Defensive invariant: APPROVE is reserved for human reviewers.
    expect(computeReviewEvent([], 'never')).not.toBe('APPROVE');
    expect(computeReviewEvent([makeComment({ severity: 'info' })], 'never')).not.toBe('APPROVE');
  });
});
