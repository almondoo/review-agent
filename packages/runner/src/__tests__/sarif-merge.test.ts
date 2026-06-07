/**
 * Tests for external SARIF findings merge logic (#160).
 *
 * Tests `mergeExternalFindings` indirectly by driving `runReview` with
 * `job.externalTools` set and asserting the final comment list.
 */

import type { LlmProvider, ReviewOutput } from '@review-agent/llm';
import { describe, expect, it, vi } from 'vitest';
import { runReview } from '../agent.js';
import type { ReviewJob } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSarifContent(
  ruleId: string,
  path: string,
  line: number,
  level: 'error' | 'warning' | 'note' = 'warning',
  message = 'External finding.',
): string {
  return JSON.stringify({
    version: '2.1.0',
    runs: [
      {
        tool: { driver: { name: 'TestTool', rules: [{ id: ruleId }] } },
        results: [
          {
            ruleId,
            level,
            message: { text: message },
            locations: [
              {
                physicalLocation: {
                  artifactLocation: { uri: path },
                  region: { startLine: line },
                },
              },
            ],
          },
        ],
      },
    ],
  });
}

const baseJob: ReviewJob = {
  jobId: 'job-sarif-test',
  workspaceDir: '/tmp/sarif-test',
  diffText: 'diff --git a/src/a.ts b/src/a.ts',
  prMetadata: { title: 'Test PR', body: '', author: 'alice' },
  previousState: null,
  profile: 'test.',
  pathInstructions: [],
  skills: [],
  language: 'en-US',
  costCapUsd: 2.0,
  pathFilters: [],
  maxFiles: 50,
  maxDiffLines: 3000,
  privacy: { allowedUrlPrefixes: [], denyPaths: [], redactPatterns: [] },
  prRepo: { host: 'github.com', owner: 'test-owner', repo: 'test-repo' },
};

/** AI output that has a comment at src/a.ts:10 with ruleId sql-injection */
const aiOutputWithConflict: ReviewOutput = {
  summary: 'AI found issues.',
  comments: [
    {
      path: 'src/a.ts',
      line: 10,
      side: 'RIGHT',
      body: 'AI: use parameterized query',
      severity: 'major',
      ruleId: 'sql-injection',
    },
  ],
  tokensUsed: { input: 500, output: 100 },
  costUsd: 0.001,
};

/** AI output with a comment that does NOT conflict with any external finding */
const aiOutputNoConflict: ReviewOutput = {
  summary: 'AI found one issue.',
  comments: [
    {
      path: 'src/b.ts',
      line: 5,
      side: 'RIGHT',
      body: 'AI: missing null check',
      severity: 'minor',
      ruleId: 'null-check',
    },
  ],
  tokensUsed: { input: 500, output: 100 },
  costUsd: 0.001,
};

function makeProvider(output: ReviewOutput): LlmProvider {
  return {
    name: 'anthropic',
    model: 'claude-sonnet-4-6',
    classifyError: vi.fn(() => ({ kind: 'fatal' as const })),
    pricePerMillionTokens: vi.fn(() => ({ input: 3, output: 15 })),
    estimateCost: vi.fn(async () => ({ inputTokens: 500, estimatedUsd: 0.001 })),
    generateReview: vi.fn(async () => output),
  };
}

// ---------------------------------------------------------------------------
// Back-compat: externalTools absent → behaviour unchanged
// ---------------------------------------------------------------------------

describe('mergeExternalFindings — back-compat', () => {
  it('returns only AI comments when externalTools is absent', async () => {
    const provider = makeProvider(aiOutputWithConflict);
    const result = await runReview(baseJob, provider);
    expect(result.comments).toHaveLength(1);
    expect(result.comments[0]?.body).toContain('AI:');
  });

  it('returns only AI comments when externalTools is an empty array', async () => {
    const provider = makeProvider(aiOutputWithConflict);
    const job: ReviewJob = { ...baseJob, externalTools: [] };
    const result = await runReview(job, provider);
    expect(result.comments).toHaveLength(1);
    expect(result.comments[0]?.body).toContain('AI:');
  });
});

// ---------------------------------------------------------------------------
// Non-conflicting findings: both kept
// ---------------------------------------------------------------------------

describe('mergeExternalFindings — non-conflicting findings kept from both sides', () => {
  it('tool_wins: keeps AI + external when fingerprints differ', async () => {
    // External finding at different path/line/ruleId → no fingerprint conflict.
    const sarif = makeSarifContent('other-rule', 'src/c.ts', 99);
    const job: ReviewJob = {
      ...baseJob,
      externalTools: [{ name: 'TestTool', mergePolicy: 'tool_wins', sarif }],
    };
    const provider = makeProvider(aiOutputNoConflict);
    const result = await runReview(job, provider);
    // Should have 2 comments: AI's (src/b.ts:5) + external (src/c.ts:99)
    expect(result.comments).toHaveLength(2);
    const paths = result.comments.map((c) => c.path);
    expect(paths).toContain('src/b.ts');
    expect(paths).toContain('src/c.ts');
  });
});

// ---------------------------------------------------------------------------
// Merge policy: tool_wins
// ---------------------------------------------------------------------------

describe('mergeExternalFindings — merge_policy: tool_wins', () => {
  it('on fingerprint conflict, keeps external finding and drops AI duplicate', async () => {
    // External finding at same path/line/ruleId as AI output → conflict.
    // Fingerprint: path=src/a.ts, line=10, ruleId=sql-injection, suggestionType=comment
    const sarif = makeSarifContent('sql-injection', 'src/a.ts', 10, 'error', 'Tool: SQL injection');
    const job: ReviewJob = {
      ...baseJob,
      externalTools: [{ name: 'TestTool', mergePolicy: 'tool_wins', sarif }],
    };
    const provider = makeProvider(aiOutputWithConflict);
    const result = await runReview(job, provider);
    expect(result.comments).toHaveLength(1);
    expect(result.comments[0]?.body).toContain('Tool:');
    expect(result.comments[0]?.body).not.toContain('AI:');
  });
});

// ---------------------------------------------------------------------------
// Merge policy: ai_wins
// ---------------------------------------------------------------------------

describe('mergeExternalFindings — merge_policy: ai_wins', () => {
  it('on fingerprint conflict, keeps AI finding and drops external duplicate', async () => {
    const sarif = makeSarifContent('sql-injection', 'src/a.ts', 10, 'error', 'Tool: SQL injection');
    const job: ReviewJob = {
      ...baseJob,
      externalTools: [{ name: 'TestTool', mergePolicy: 'ai_wins', sarif }],
    };
    const provider = makeProvider(aiOutputWithConflict);
    const result = await runReview(job, provider);
    expect(result.comments).toHaveLength(1);
    expect(result.comments[0]?.body).toContain('AI:');
    expect(result.comments[0]?.body).not.toContain('Tool:');
  });

  it('ai_wins: still adds non-conflicting external findings', async () => {
    const sarif = makeSarifContent('other-rule', 'src/z.ts', 200, 'warning', 'Tool: extra');
    const job: ReviewJob = {
      ...baseJob,
      externalTools: [{ name: 'TestTool', mergePolicy: 'ai_wins', sarif }],
    };
    const provider = makeProvider(aiOutputNoConflict);
    const result = await runReview(job, provider);
    expect(result.comments).toHaveLength(2);
    const paths = result.comments.map((c) => c.path);
    expect(paths).toContain('src/z.ts');
  });
});

// ---------------------------------------------------------------------------
// Merge policy: annotate
// ---------------------------------------------------------------------------

describe('mergeExternalFindings — merge_policy: annotate', () => {
  it('on fingerprint conflict, appends annotation to AI body and drops external dup', async () => {
    const sarif = makeSarifContent('sql-injection', 'src/a.ts', 10, 'error', 'Tool: SQL injection');
    const job: ReviewJob = {
      ...baseJob,
      externalTools: [{ name: 'TestTool', mergePolicy: 'annotate', sarif }],
    };
    const provider = makeProvider(aiOutputWithConflict);
    const result = await runReview(job, provider);
    expect(result.comments).toHaveLength(1);
    const body = result.comments[0]?.body ?? '';
    expect(body).toContain('AI: use parameterized query');
    expect(body).toContain('_Also flagged by TestTool');
    // ruleId annotation
    expect(body).toContain('`sql-injection`');
  });

  it('annotate: adds non-conflicting external findings', async () => {
    const sarif = makeSarifContent('other-rule', 'src/x.ts', 15, 'warning', 'Tool: extra');
    const job: ReviewJob = {
      ...baseJob,
      externalTools: [{ name: 'TestTool', mergePolicy: 'annotate', sarif }],
    };
    const provider = makeProvider(aiOutputNoConflict);
    const result = await runReview(job, provider);
    expect(result.comments).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Dedup: previousState / rejectedFingerprints filter external findings
// ---------------------------------------------------------------------------

describe('mergeExternalFindings — previousState dedup filters external findings', () => {
  it('external findings whose fingerprint is in previousState are excluded', async () => {
    const sarif = makeSarifContent('sql-injection', 'src/a.ts', 10, 'error');
    // Compute the fingerprint that the external finding will get.
    // fingerprint(path=src/a.ts, line=10, ruleId=sql-injection, suggestionType=comment)
    const { fingerprint } = await import('@review-agent/core');
    const fp = fingerprint({
      path: 'src/a.ts',
      line: 10,
      ruleId: 'sql-injection',
      suggestionType: 'comment',
    });

    const job: ReviewJob = {
      ...baseJob,
      externalTools: [{ name: 'TestTool', mergePolicy: 'tool_wins', sarif }],
      previousState: {
        schemaVersion: 1,
        lastReviewedSha: 'abc',
        baseSha: 'def',
        reviewedAt: new Date().toISOString(),
        modelUsed: 'claude',
        totalTokens: 0,
        totalCostUsd: 0,
        commentFingerprints: [fp],
      },
    };

    // AI returns no conflicting comment.
    const provider = makeProvider(aiOutputNoConflict);
    const result = await runReview(job, provider);
    // External finding at src/a.ts:10 should be filtered by previousState.
    const paths = result.comments.map((c) => c.path);
    expect(paths).not.toContain('src/a.ts');
  });
});
