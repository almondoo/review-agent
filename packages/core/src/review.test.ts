import { describe, expect, it } from 'vitest';
import { CATEGORIES, formatCategoryRollup, type InlineComment } from './review.js';

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
