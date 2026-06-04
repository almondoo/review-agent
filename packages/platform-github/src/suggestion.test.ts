import { describe, expect, it } from 'vitest';
import { buildSuggestionBody, buildValidRightLines } from './suggestion.js';

// ---------------------------------------------------------------------------
// buildValidRightLines
// ---------------------------------------------------------------------------

describe('buildValidRightLines', () => {
  it('returns empty set for null/undefined patch', () => {
    expect(buildValidRightLines(null).size).toBe(0);
    expect(buildValidRightLines(undefined).size).toBe(0);
    expect(buildValidRightLines('').size).toBe(0);
  });

  it('parses a single hunk with context and addition lines', () => {
    // @@ -1,3 +1,4 @@
    // ' context'   line 1  → valid
    // '+addition'  line 2  → valid
    // ' context'   line 3  → valid
    // '+addition'  line 4  → valid
    const patch = [
      '@@ -1,3 +1,4 @@',
      ' context at 1',
      '+added at 2',
      ' context at 3',
      '+added at 4',
    ].join('\n');

    const valid = buildValidRightLines(patch);
    expect(valid.has(1)).toBe(true);
    expect(valid.has(2)).toBe(true);
    expect(valid.has(3)).toBe(true);
    expect(valid.has(4)).toBe(true);
    expect(valid.size).toBe(4);
  });

  it('excludes deletion lines from valid RIGHT-side set', () => {
    // @@ -1,3 +1,2 @@
    // ' context'  line 1  → valid RIGHT
    // '-removed'          → does NOT advance RIGHT counter
    // '+added'    line 2  → valid RIGHT
    const patch = ['@@ -1,3 +1,2 @@', ' context', '-removed line', '+added line'].join('\n');

    const valid = buildValidRightLines(patch);
    expect(valid.has(1)).toBe(true);
    expect(valid.has(2)).toBe(true);
    // Deletion did not consume a RIGHT line number.
    expect(valid.size).toBe(2);
  });

  it('handles multiple hunks with non-contiguous line ranges', () => {
    // Two hunks: first at lines 1-2, second at lines 10-11.
    const patch = [
      '@@ -1,2 +1,2 @@',
      ' context at 1',
      '+added at 2',
      '@@ -10,2 +10,2 @@',
      ' context at 10',
      '+added at 11',
    ].join('\n');

    const valid = buildValidRightLines(patch);
    expect(valid.has(1)).toBe(true);
    expect(valid.has(2)).toBe(true);
    expect(valid.has(10)).toBe(true);
    expect(valid.has(11)).toBe(true);
    // Lines 3-9 are NOT in any hunk window.
    expect(valid.has(5)).toBe(false);
    expect(valid.size).toBe(4);
  });

  it('handles a single-line hunk (no comma in +c part)', () => {
    // @@ -5 +5 @@  — single line, no count ⇒ count defaults to 1
    const patch = ['@@ -5 +5 @@', '+added at 5'].join('\n');
    const valid = buildValidRightLines(patch);
    expect(valid.has(5)).toBe(true);
    expect(valid.size).toBe(1);
  });

  it('ignores backslash "no newline at end" lines', () => {
    const patch = ['@@ -1,1 +1,1 @@', '+added at 1', '\\ No newline at end of file'].join('\n');
    const valid = buildValidRightLines(patch);
    expect(valid.has(1)).toBe(true);
    expect(valid.size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// buildSuggestionBody
// ---------------------------------------------------------------------------

describe('buildSuggestionBody', () => {
  it('returns body unchanged when suggestion is undefined', () => {
    const result = buildSuggestionBody('body text', undefined, 'RIGHT', 5, new Set([5]));
    expect(result).toBe('body text');
  });

  it('returns body unchanged when suggestion is empty string', () => {
    const result = buildSuggestionBody('body text', '', 'RIGHT', 5, new Set([5]));
    expect(result).toBe('body text');
  });

  it('suppresses suggestion when side is LEFT', () => {
    const result = buildSuggestionBody('body', 'fix code', 'LEFT', 5, new Set([5]));
    expect(result).toBe('body');
    expect(result).not.toContain('```suggestion');
  });

  it('suppresses suggestion when line is outside hunk (not in validRightLines)', () => {
    // Line 7 is not in the valid set.
    const result = buildSuggestionBody('body', 'fix code', 'RIGHT', 7, new Set([5, 6, 8]));
    expect(result).toBe('body');
    expect(result).not.toContain('```suggestion');
  });

  it('appends ```suggestion block when side is RIGHT and line is in valid set', () => {
    const result = buildSuggestionBody('body text', 'const x = 1;', 'RIGHT', 5, new Set([5]));
    expect(result).toBe('body text\n\n```suggestion\nconst x = 1;\n```');
  });

  it('suggestion block handles multi-line suggestion text', () => {
    const suggestion = 'const x = 1;\nconst y = 2;';
    const result = buildSuggestionBody('body', suggestion, 'RIGHT', 3, new Set([3]));
    expect(result).toBe('body\n\n```suggestion\nconst x = 1;\nconst y = 2;\n```');
  });

  it('suggestion block is placed before fingerprint marker would be appended (body is not modified otherwise)', () => {
    // The caller appends the fingerprint marker AFTER this function returns.
    // Verify the function itself does not alter the incoming body aside from
    // the appended suggestion block.
    const result = buildSuggestionBody(
      'note: potential null deref',
      'if (x) { return x.value; }',
      'RIGHT',
      10,
      new Set([10]),
    );
    expect(result.startsWith('note: potential null deref\n\n```suggestion\n')).toBe(true);
    expect(result.endsWith('\n```')).toBe(true);
  });
});
