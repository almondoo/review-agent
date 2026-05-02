import { CostExceededError, SchemaValidationError } from '@review-agent/core';
import type { LlmProvider, ReviewOutput } from '@review-agent/llm';
import { describe, expect, it, vi } from 'vitest';
import { runReview } from './agent.js';
import type { ReviewJob } from './types.js';

const baseJob: ReviewJob = {
  jobId: 'job-1',
  workspaceDir: '/tmp/job-1',
  diffText: 'diff --git a/x b/x',
  prMetadata: { title: 'Add x', body: 'Adds x to the project.', author: 'alice' },
  previousState: null,
  profile: 'TS-only.',
  pathInstructions: [],
  skills: [],
  language: 'en-US',
  costCapUsd: 2.0,
};

const validOutput: ReviewOutput = {
  summary: 'Two findings.',
  comments: [
    {
      path: 'src/a.ts',
      line: 1,
      side: 'RIGHT',
      body: 'Extract to a helper.',
      severity: 'minor',
    },
    {
      path: 'src/b.ts',
      line: 5,
      side: 'RIGHT',
      body: 'Use parameterized query.',
      severity: 'major',
      suggestion: 'db.query("SELECT 1")',
    },
  ],
  tokensUsed: { input: 1000, output: 200 },
  costUsd: 0.0045,
};

function makeProvider(overrides: Partial<LlmProvider> = {}): LlmProvider {
  return {
    name: 'anthropic',
    model: 'claude-sonnet-4-6',
    classifyError: vi.fn(() => ({ kind: 'fatal' as const })),
    pricePerMillionTokens: vi.fn(() => ({ input: 3, output: 15 })),
    estimateCost: vi.fn(async () => ({ inputTokens: 1000, estimatedUsd: 0.003 })),
    generateReview: vi.fn(async () => validOutput),
    ...overrides,
  };
}

describe('runReview — happy path', () => {
  it('returns dedupped comments + cost + provider metadata', async () => {
    const provider = makeProvider();
    const result = await runReview(baseJob, provider);
    expect(result.comments).toHaveLength(2);
    expect(result.summary).toBe('Two findings.');
    expect(result.costUsd).toBeCloseTo(0.0045);
    expect(result.provider).toBe('anthropic');
    expect(result.model).toBe('claude-sonnet-4-6');
    expect(result.droppedDuplicates).toBe(0);
  });

  it('attaches deterministic fingerprints to each kept comment', async () => {
    const provider = makeProvider();
    const result = await runReview(baseJob, provider);
    for (const c of result.comments) {
      expect(c.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    }
  });

  it('feeds the LLM a system prompt with profile + language directive', async () => {
    const provider = makeProvider();
    await runReview(baseJob, provider);
    const callArgs = (provider.generateReview as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(callArgs.systemPrompt).toContain('## Profile\nTS-only.');
    expect(callArgs.systemPrompt).toContain('Write all comment bodies and the summary in en-US');
  });

  it('feeds the LLM a diff that wraps PR metadata in <untrusted>', async () => {
    const provider = makeProvider();
    await runReview(baseJob, provider);
    const callArgs = (provider.generateReview as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(callArgs.diffText).toContain('<untrusted>');
    expect(callArgs.diffText).toContain('<title>Add x</title>');
    expect(callArgs.diffText).toContain('diff --git a/x b/x');
  });
});

describe('runReview — schema retry', () => {
  it('retries once on schema violation with a corrective suffix', async () => {
    const generateReview = vi
      .fn<LlmProvider['generateReview']>()
      .mockResolvedValueOnce({ ...validOutput, summary: '' })
      .mockResolvedValueOnce(validOutput);
    const provider = makeProvider({ generateReview });
    const result = await runReview(baseJob, provider);
    expect(result.summary).toBe('Two findings.');
    expect(generateReview).toHaveBeenCalledTimes(2);
    const secondCall = generateReview.mock.calls[1]?.[0];
    expect(secondCall?.systemPrompt).toContain('your previous response failed schema validation');
  });

  it('aborts (throws) when the second attempt also violates schema', async () => {
    const generateReview = vi
      .fn<LlmProvider['generateReview']>()
      .mockResolvedValue({ ...validOutput, summary: '' });
    const provider = makeProvider({ generateReview });
    await expect(runReview(baseJob, provider)).rejects.toBeInstanceOf(SchemaValidationError);
    expect(generateReview).toHaveBeenCalledTimes(2);
  });
});

describe('runReview — cost guard', () => {
  it('aborts pre-request when projected cost exceeds the cap', async () => {
    const provider = makeProvider({
      estimateCost: vi.fn(async () => ({ inputTokens: 1_000_000, estimatedUsd: 5.0 })),
    });
    await expect(runReview(baseJob, provider)).rejects.toBeInstanceOf(CostExceededError);
    expect(provider.generateReview).not.toHaveBeenCalled();
  });

  it('proceeds when projected cost is within cap', async () => {
    const provider = makeProvider({
      estimateCost: vi.fn(async () => ({ inputTokens: 1000, estimatedUsd: 0.003 })),
    });
    const result = await runReview(baseJob, provider);
    expect(result.provider).toBe('anthropic');
    expect(result.comments).toHaveLength(2);
    expect(result.droppedDuplicates).toBe(0);
    expect(provider.generateReview).toHaveBeenCalledTimes(1);
  });

  it('skips cost guard entirely when costCapUsd is 0', async () => {
    const provider = makeProvider({
      estimateCost: vi.fn(async () => ({ inputTokens: 999, estimatedUsd: 9999 })),
    });
    await runReview({ ...baseJob, costCapUsd: 0 }, provider);
    expect(provider.estimateCost).not.toHaveBeenCalled();
  });
});

describe('runReview — dedup against previousState', () => {
  it('drops comments whose fingerprint is already in previousState', async () => {
    const provider = makeProvider();
    const firstRun = await runReview(baseJob, provider);
    const fps = firstRun.comments.map((c) => c.fingerprint);
    const previousState = {
      schemaVersion: 1 as const,
      lastReviewedSha: 'old',
      baseSha: 'b',
      reviewedAt: 'r',
      modelUsed: 'm',
      totalTokens: 0,
      totalCostUsd: 0,
      commentFingerprints: fps,
    };
    const secondRun = await runReview({ ...baseJob, previousState }, provider);
    expect(secondRun.comments).toHaveLength(0);
    expect(secondRun.droppedDuplicates).toBe(2);
  });
});
