import type { PR, PRRef, ReviewState, VCS } from '@review-agent/core';
import type { LlmProvider } from '@review-agent/llm';
import { describe, expect, it, vi } from 'vitest';
import type { ActionInputs } from './inputs.js';
import { runAction } from './run.js';

const inputs: ActionInputs = {
  githubToken: 'gh_token',
  anthropicApiKey: 'sk-ant-test',
  language: 'en-US',
  configPath: '.review-agent.yml',
  costCapUsd: 1.0,
};

const ref: PRRef = { platform: 'github', owner: 'o', repo: 'r', number: 1 };

const samplePR: PR = {
  ref,
  title: 'Add feature',
  body: 'desc',
  author: 'alice',
  baseSha: 'B',
  headSha: 'H',
  baseRef: 'main',
  headRef: 'feat',
  draft: false,
  labels: [],
  createdAt: '',
  updatedAt: '',
};

function makeVCS(overrides: Partial<VCS> = {}): VCS {
  return {
    platform: 'github',
    getPR: vi.fn(async () => samplePR),
    getDiff: vi.fn(async () => ({ baseSha: 'B', headSha: 'H', files: [] })),
    getFile: vi.fn(),
    cloneRepo: vi.fn(),
    postReview: vi.fn(async () => undefined),
    postSummary: vi.fn(async () => ({ commentId: '1' })),
    getExistingComments: vi.fn(async () => []),
    getStateComment: vi.fn(async () => null),
    upsertStateComment: vi.fn(async () => undefined),
    ...overrides,
  };
}

function makeProvider(): LlmProvider {
  return {
    name: 'anthropic',
    model: 'claude-sonnet-4-6',
    classifyError: vi.fn(() => ({ kind: 'fatal' as const })),
    pricePerMillionTokens: vi.fn(() => ({ input: 3, output: 15 })),
    estimateCost: vi.fn(async () => ({ inputTokens: 100, estimatedUsd: 0.001 })),
    generateReview: vi.fn(async () => ({
      summary: 'OK',
      comments: [],
      tokensUsed: { input: 100, output: 50 },
      costUsd: 0.001,
    })),
  };
}

describe('runAction', () => {
  it('skips draft PRs by default', async () => {
    const vcs = makeVCS({ getPR: vi.fn(async () => ({ ...samplePR, draft: true })) });
    const result = await runAction(
      inputs,
      { ref },
      {
        readFile: async () => {
          throw new Error('no config');
        },
        createVCS: () => vcs,
        createProvider: () => makeProvider(),
      },
    );
    expect(result.skipped).toBe(true);
    expect(result.skipReason).toContain('draft');
    expect(vcs.postReview).not.toHaveBeenCalled();
  });

  it('skips dependabot[bot] author by default', async () => {
    const vcs = makeVCS({
      getPR: vi.fn(async () => ({ ...samplePR, author: 'dependabot[bot]' })),
    });
    const result = await runAction(
      inputs,
      { ref },
      {
        readFile: async () => {
          throw new Error('no config');
        },
        createVCS: () => vcs,
        createProvider: () => makeProvider(),
      },
    );
    expect(result.skipped).toBe(true);
    expect(result.skipReason).toContain('dependabot');
  });

  it('runs review and posts both inline review and state comment', async () => {
    const vcs = makeVCS();
    const result = await runAction(
      inputs,
      { ref },
      {
        readFile: async () => {
          throw new Error('no config');
        },
        createVCS: () => vcs,
        createProvider: () => makeProvider(),
      },
    );
    expect(result.skipped).toBe(false);
    expect(vcs.postReview).toHaveBeenCalledTimes(1);
    expect(vcs.upsertStateComment).toHaveBeenCalledTimes(1);
    const stateArg = (vcs.upsertStateComment as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as
      | ReviewState
      | undefined;
    expect(stateArg?.lastReviewedSha).toBe('H');
    expect(stateArg?.modelUsed).toBe('claude-sonnet-4-6');
  });

  it('defers when coordination.other_bots is defer_if_present and a known bot has commented', async () => {
    const vcs = makeVCS({
      getExistingComments: vi.fn(async () => [
        {
          id: 1,
          path: 'a.ts',
          line: 1,
          side: 'RIGHT' as const,
          body: 'looks good',
          author: 'coderabbitai[bot]',
          createdAt: '',
        },
      ]),
    });
    const result = await runAction(
      inputs,
      { ref },
      {
        readFile: async () => 'coordination:\n  other_bots: defer_if_present\n',
        createVCS: () => vcs,
        createProvider: () => makeProvider(),
      },
    );
    expect(result.skipped).toBe(true);
    expect(result.skipReason).toContain('coderabbitai[bot]');
    // Posts the deferral summary, but no inline review and no state row.
    expect(vcs.postSummary).toHaveBeenCalledTimes(1);
    expect(vcs.postReview).not.toHaveBeenCalled();
    expect(vcs.upsertStateComment).not.toHaveBeenCalled();
  });

  it('proceeds with the review when coordination.other_bots is ignore even if a known bot has commented', async () => {
    const vcs = makeVCS({
      getExistingComments: vi.fn(async () => [
        {
          id: 1,
          path: 'a.ts',
          line: 1,
          side: 'RIGHT' as const,
          body: 'looks good',
          author: 'coderabbitai[bot]',
          createdAt: '',
        },
      ]),
    });
    const result = await runAction(
      inputs,
      { ref },
      {
        // Explicit `ignore` rather than empty YAML so the test fails
        // if a future change to `defaultConfig` flips the default.
        readFile: async () => 'coordination:\n  other_bots: ignore\n',
        createVCS: () => vcs,
        createProvider: () => makeProvider(),
      },
    );
    expect(result.skipped).toBe(false);
    expect(vcs.postReview).toHaveBeenCalledTimes(1);
    // Short-circuit invariant: ignore mode does not call
    // getExistingComments, so we don't pay the API call when
    // coordination is off.
    expect(vcs.getExistingComments).not.toHaveBeenCalled();
  });

  it('respects coordination.other_bots_logins for operator-supplied custom bot logins', async () => {
    const vcs = makeVCS({
      getExistingComments: vi.fn(async () => [
        {
          id: 1,
          path: 'a.ts',
          line: 1,
          side: 'RIGHT' as const,
          body: 'looks good',
          author: 'acme-internal-reviewer[bot]',
          createdAt: '',
        },
      ]),
    });
    const yaml = [
      'coordination:',
      '  other_bots: defer_if_present',
      '  other_bots_logins:',
      '    - acme-internal-reviewer[bot]',
      '',
    ].join('\n');
    const result = await runAction(
      inputs,
      { ref },
      {
        readFile: async () => yaml,
        createVCS: () => vcs,
        createProvider: () => makeProvider(),
      },
    );
    expect(result.skipped).toBe(true);
    expect(result.skipReason).toContain('acme-internal-reviewer[bot]');
  });

  it('surfaces cost-cap violations as a thrown error and posts no comments', async () => {
    const vcs = makeVCS();
    const provider = makeProvider();
    // estimate >> costCapUsd → runner.cost-guard aborts with CostExceededError.
    provider.estimateCost = vi.fn(async () => ({
      inputTokens: 1_000_000,
      estimatedUsd: 100,
    }));
    await expect(
      runAction(
        { ...inputs, costCapUsd: 0.01 },
        { ref },
        {
          readFile: async () => {
            throw new Error('no config');
          },
          createVCS: () => vcs,
          createProvider: () => provider,
        },
      ),
    ).rejects.toThrow(/cost/i);
    expect(vcs.postReview).not.toHaveBeenCalled();
    expect(vcs.upsertStateComment).not.toHaveBeenCalled();
  });
});
