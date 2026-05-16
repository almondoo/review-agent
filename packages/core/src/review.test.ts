import { describe, expect, it } from 'vitest';
import {
  CATEGORIES,
  computeReviewEvent,
  formatCategoryRollup,
  type InlineComment,
} from './review.js';

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

describe('formatCategoryRollup', () => {
  it('returns empty string when no comment has a category', () => {
    expect(formatCategoryRollup([makeComment(), makeComment({ line: 2 })])).toBe('');
  });

  it('returns empty string for empty input', () => {
    expect(formatCategoryRollup([])).toBe('');
  });

  it('lists each present category with its count', () => {
    const out = formatCategoryRollup([
      makeComment({ category: 'bug' }),
      makeComment({ line: 2, category: 'bug' }),
      makeComment({ line: 3, category: 'security' }),
      makeComment({ line: 4, category: 'style' }),
    ]);
    expect(out).toContain('### Findings by category');
    expect(out).toContain('- bug: 2');
    expect(out).toContain('- security: 1');
    expect(out).toContain('- style: 1');
  });

  it('emits categories in CATEGORIES order (deterministic)', () => {
    const out = formatCategoryRollup([
      makeComment({ category: 'test' }),
      makeComment({ line: 2, category: 'bug' }),
      makeComment({ line: 3, category: 'docs' }),
      makeComment({ line: 4, category: 'security' }),
    ]);
    const lines = out.split('\n');
    // Header at [0], then bullets in CATEGORIES order
    const orderedSeen = lines
      .slice(1)
      .map((l) => l.replace(/^- (\w+):.*$/, '$1'))
      .filter(Boolean);
    const expected = CATEGORIES.filter((c) => ['bug', 'security', 'docs', 'test'].includes(c));
    expect(orderedSeen).toEqual(expected);
  });

  it('skips categories with zero count', () => {
    const out = formatCategoryRollup([makeComment({ category: 'bug' })]);
    expect(out).toBe('### Findings by category\n- bug: 1');
  });

  it('ignores comments without a category alongside categorized ones', () => {
    const out = formatCategoryRollup([
      makeComment(),
      makeComment({ line: 2, category: 'performance' }),
    ]);
    expect(out).toBe('### Findings by category\n- performance: 1');
  });
});

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
