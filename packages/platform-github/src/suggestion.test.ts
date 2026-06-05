import { describe, expect, it } from 'vitest';
import { buildSuggestionBody, buildValidRightLines, isRangeInHunk } from './suggestion.js';

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

// ---------------------------------------------------------------------------
// isRangeInHunk (#165)
// ---------------------------------------------------------------------------

describe('isRangeInHunk', () => {
  it('returns true when every line in range is in the valid set', () => {
    const valid = new Set([5, 6, 7, 8, 9]);
    expect(isRangeInHunk(5, 9, valid)).toBe(true);
  });

  it('returns true for a single-step range (startLine === endLine - 1)', () => {
    const valid = new Set([3, 4]);
    expect(isRangeInHunk(3, 4, valid)).toBe(true);
  });

  it('returns false when the first line of range is missing', () => {
    const valid = new Set([6, 7, 8]);
    expect(isRangeInHunk(5, 8, valid)).toBe(false);
  });

  it('returns false when the last line of range is missing', () => {
    const valid = new Set([5, 6, 7]);
    expect(isRangeInHunk(5, 8, valid)).toBe(false);
  });

  it('returns false when an interior line of range is missing (hunk gap)', () => {
    // Line 7 is missing — range spans two hunks.
    const valid = new Set([5, 6, 8, 9]);
    expect(isRangeInHunk(5, 9, valid)).toBe(false);
  });

  it('returns false for an empty valid set', () => {
    expect(isRangeInHunk(1, 3, new Set())).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildSuggestionBody — multi-line range (#165)
// ---------------------------------------------------------------------------

describe('buildSuggestionBody (multi-line, #165)', () => {
  // Range fully inside a single hunk → suggestion block rendered.
  it('renders ```suggestion block for multi-line range when all lines are in hunk', () => {
    const valid = new Set([3, 4, 5]);
    const result = buildSuggestionBody(
      'replace this block',
      'const a = 1;\nconst b = 2;',
      'RIGHT',
      5, // endLine
      valid,
      3, // startLine
    );
    expect(result).toBe('replace this block\n\n```suggestion\nconst a = 1;\nconst b = 2;\n```');
  });

  // Range partially outside hunk → suppress to plain comment.
  it('suppresses multi-line suggestion when part of range is outside hunk', () => {
    // Lines 3-5 valid, but startLine=2 is outside.
    const valid = new Set([3, 4, 5]);
    const result = buildSuggestionBody('body', 'const x = 1;', 'RIGHT', 5, valid, 2);
    expect(result).toBe('body');
    expect(result).not.toContain('```suggestion');
  });

  it('suppresses multi-line suggestion when range spans two hunks (gap in valid set)', () => {
    // Hunk 1 covers lines 3-5; hunk 2 covers lines 10-12. Line 6-9 are gaps.
    const valid = new Set([3, 4, 5, 10, 11, 12]);
    const result = buildSuggestionBody('body', 'replacement', 'RIGHT', 10, valid, 3);
    expect(result).toBe('body');
    expect(result).not.toContain('```suggestion');
  });

  it('suppresses multi-line suggestion when startSide is LEFT', () => {
    const valid = new Set([3, 4, 5]);
    const result = buildSuggestionBody(
      'body',
      'const x = 1;',
      'RIGHT',
      5,
      valid,
      3,
      'LEFT', // startSide LEFT → suppress
    );
    expect(result).toBe('body');
    expect(result).not.toContain('```suggestion');
  });

  it('suppresses multi-line suggestion when side is LEFT', () => {
    const valid = new Set([3, 4, 5]);
    const result = buildSuggestionBody(
      'body',
      'const x = 1;',
      'LEFT', // side LEFT → suppress regardless of startLine
      5,
      valid,
      3,
    );
    expect(result).toBe('body');
    expect(result).not.toContain('```suggestion');
  });

  it('suppresses multi-line suggestion when startLine >= line (GitHub API constraint)', () => {
    const valid = new Set([5, 6, 7]);
    // startLine === line: violates GitHub constraint
    const result1 = buildSuggestionBody('body', 'fix', 'RIGHT', 5, valid, 5);
    expect(result1).toBe('body');
    // startLine > line: inverted range
    const result2 = buildSuggestionBody('body', 'fix', 'RIGHT', 5, valid, 7);
    expect(result2).toBe('body');
  });

  it('uses startSide defaulting (absent → RIGHT, no suppression)', () => {
    const valid = new Set([4, 5, 6]);
    const result = buildSuggestionBody('body', 'fix', 'RIGHT', 6, valid, 4);
    expect(result).toContain('```suggestion\nfix\n```');
  });

  it('back-compat: single-line path unchanged when startLine is absent', () => {
    const valid = new Set([5]);
    const result = buildSuggestionBody('body', 'const x = 1;', 'RIGHT', 5, valid);
    expect(result).toBe('body\n\n```suggestion\nconst x = 1;\n```');
  });
});
