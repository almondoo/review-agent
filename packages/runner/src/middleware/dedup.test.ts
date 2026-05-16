import type { ReviewState } from '@review-agent/core';
import type { ReviewOutput, ReviewOutputComment } from '@review-agent/llm';
import { describe, expect, it } from 'vitest';
import { dedupComments } from './dedup.js';

function comment(overrides: Partial<ReviewOutputComment> = {}): ReviewOutputComment {
  return {
    path: 'src/auth.ts',
    line: 10,
    side: 'RIGHT',
    body: 'note',
    severity: 'major',
    ...overrides,
  };
}

function output(...comments: ReviewOutputComment[]): ReviewOutput {
  return {
    comments,
    summary: 'ok',
    tokensUsed: { input: 100, output: 50 },
    costUsd: 0.01,
  };
}

const fixedFingerprint =
  (label: string) =>
  (input: { ruleId: string; path: string; line: number; suggestionType: string }): string =>
    `fp:${label}:${input.path}:${input.line}:${input.ruleId}:${input.suggestionType}`;

describe('dedupComments', () => {
  it('keeps a single comment with no previous state', () => {
    const result = dedupComments(output(comment()), {
      fingerprintFn: fixedFingerprint('a'),
    });
    expect(result.kept).toHaveLength(1);
    expect(result.droppedCount).toBe(0);
    expect(result.kept[0]?.fingerprint).toContain('fp:a:src/auth.ts:10:major');
  });

  it('drops a comment whose fingerprint is already in previousState', () => {
    const fingerprintFn = fixedFingerprint('a');
    const fp = fingerprintFn({
      path: 'src/auth.ts',
      line: 10,
      ruleId: 'major',
      suggestionType: 'comment',
    });
    const previous: ReviewState = {
      schemaVersion: 1,
      lastReviewedSha: '0123456789abcdef0123456789abcdef01234567',
      baseSha: 'fedcba9876543210fedcba9876543210fedcba98',
      reviewedAt: '2026-04-30T10:00:00.000Z',
      modelUsed: 'm',
      totalTokens: 100,
      totalCostUsd: 0.01,
      commentFingerprints: [fp],
    };
    const result = dedupComments(output(comment()), {
      previousState: previous,
      fingerprintFn,
    });
    expect(result.kept).toHaveLength(0);
    expect(result.droppedCount).toBe(1);
  });

  it('keeps two findings on the same line when they declare different ruleIds', () => {
    // Without ruleId, both fingerprints collapse to (path, line, severity,
    // suggestionType) and dedup silently drops the second comment. With
    // ruleId, the two distinct rules produce two distinct fingerprints.
    const result = dedupComments(
      output(
        comment({ ruleId: 'sql-injection', body: 'Concatenated SQL.' }),
        comment({ ruleId: 'null-deref', body: 'May dereference null on retry.' }),
      ),
      { fingerprintFn: fixedFingerprint('b') },
    );
    expect(result.kept).toHaveLength(2);
    expect(result.droppedCount).toBe(0);
    const ids = result.kept.map((c) => c.fingerprint);
    expect(new Set(ids).size).toBe(2);
  });

  it('still dedupes two findings on the same line with the same ruleId', () => {
    const result = dedupComments(
      output(
        comment({ ruleId: 'sql-injection', body: 'one' }),
        comment({ ruleId: 'sql-injection', body: 'two' }),
      ),
      { fingerprintFn: fixedFingerprint('c') },
    );
    expect(result.kept).toHaveLength(1);
    expect(result.droppedCount).toBe(1);
  });

  it('falls back to severity when ruleId is absent (back-compat)', () => {
    // Two findings on the same line, both with severity=major but no
    // ruleId: collide on (path, line, severity) and one is dropped —
    // documented back-compat behavior.
    const result = dedupComments(output(comment({ body: 'one' }), comment({ body: 'two' })), {
      fingerprintFn: fixedFingerprint('d'),
    });
    expect(result.kept).toHaveLength(1);
    expect(result.droppedCount).toBe(1);
  });

  it('treats suggestion presence as a distinguishing dimension', () => {
    const result = dedupComments(
      output(
        comment({ ruleId: 'unused-var' }),
        comment({ ruleId: 'unused-var', suggestion: 'remove the line' }),
      ),
      { fingerprintFn: fixedFingerprint('e') },
    );
    expect(result.kept).toHaveLength(2);
  });
});
