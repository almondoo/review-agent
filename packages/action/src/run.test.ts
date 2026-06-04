import type { PR, PRRef, ReviewState, VCS } from '@review-agent/core';
import type { LlmProvider, ReviewInput } from '@review-agent/llm';
import { describe, expect, it, vi } from 'vitest';
import type { ActionInputs } from './inputs.js';
import { type RunActionDeps, runAction } from './run.js';

const inputs: ActionInputs = {
  githubToken: 'gh_token',
  anthropicApiKey: 'sk-ant-test',
  language: 'en-US',
  configPath: '.review-agent.yml',
  costCapUsd: 1.0,
  stateWriteRetries: 3,
};

// Inject a no-op sleep across every test so retry backoffs don't pay
// real wall-clock time. The retry helper itself has dedicated tests
// in retry.test.ts that exercise the real backoff schedule.
const noSleep = async (_ms: number) => undefined;

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
  commitMessages: [],
  createdAt: '',
  updatedAt: '',
};

function makeVCS(overrides: Partial<VCS> = {}): VCS {
  return {
    platform: 'github',
    capabilities: {
      clone: true,
      stateComment: 'native',
      approvalEvent: 'github',
      commitMessages: true,
      conversationReply: true,
      committableSuggestions: true,
    },
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

  it('runs a full diff on the first review (no previous state) and does NOT pass sinceSha', async () => {
    const vcs = makeVCS({ getStateComment: vi.fn(async () => null) });
    const computeDiffStrategy = vi.fn<RunActionDeps['computeDiffStrategy'] & object>(
      async () => 'full',
    );
    const logger = vi.fn<NonNullable<RunActionDeps['logger']>>();
    await runAction(
      inputs,
      { ref },
      {
        readFile: async () => {
          throw new Error('no config');
        },
        createVCS: () => vcs,
        createProvider: () => makeProvider(),
        computeDiffStrategy,
        logger,
      },
    );
    expect(computeDiffStrategy).toHaveBeenCalledTimes(1);
    expect(computeDiffStrategy.mock.calls[0]?.[1]).toBeNull();
    const getDiffMock = vcs.getDiff as ReturnType<typeof vi.fn>;
    expect(getDiffMock).toHaveBeenCalledTimes(1);
    expect(getDiffMock.mock.calls[0]?.[1]).toBeUndefined();
    // No 'rebase detected' since there was no previous state.
    expect(logger.mock.calls.find((c) => c[0] === 'rebase detected')).toBeUndefined();
  });

  it('runs an incremental diff (sinceSha) on a 2nd review when lastReviewedSha is reachable', async () => {
    const previousState: ReviewState = {
      schemaVersion: 1,
      lastReviewedSha: 'prevHead',
      baseSha: 'B',
      reviewedAt: '2026-05-01T00:00:00Z',
      modelUsed: 'claude-sonnet-4-6',
      totalTokens: 1234,
      totalCostUsd: 0.01,
      commentFingerprints: ['abc1', 'def2'],
    };
    const vcs = makeVCS({ getStateComment: vi.fn(async () => previousState) });
    const computeDiffStrategy = vi.fn<RunActionDeps['computeDiffStrategy'] & object>(async () => ({
      since: 'prevHead',
    }));
    const logger = vi.fn<NonNullable<RunActionDeps['logger']>>();
    const provider = makeProvider();
    await runAction(
      inputs,
      { ref },
      {
        readFile: async () => {
          throw new Error('no config');
        },
        createVCS: () => vcs,
        createProvider: () => provider,
        computeDiffStrategy,
        logger,
      },
    );
    const getDiffMock = vcs.getDiff as ReturnType<typeof vi.fn>;
    expect(getDiffMock).toHaveBeenCalledWith(ref, { sinceSha: 'prevHead' });
    // The runner-side prompt section is wired via ReviewJob.incrementalContext;
    // verify the LLM-facing systemPrompt actually carries the section.
    const generateMock = provider.generateReview as ReturnType<typeof vi.fn>;
    const reviewInput = generateMock.mock.calls[0]?.[0] as ReviewInput | undefined;
    expect(reviewInput?.systemPrompt).toContain('## Incremental review');
    expect(reviewInput?.systemPrompt).toContain('since commit `prevHead`');
    expect(reviewInput?.systemPrompt).toContain('## Previously raised findings');
    // 'incremental review' line, not 'rebase detected'.
    expect(logger.mock.calls.map((c) => c[0])).toContain('incremental review');
    expect(logger.mock.calls.map((c) => c[0])).not.toContain('rebase detected');
  });

  it('falls back to a full diff and logs "rebase detected" when lastReviewedSha is unreachable', async () => {
    const previousState: ReviewState = {
      schemaVersion: 1,
      lastReviewedSha: 'orphanedHead',
      baseSha: 'B',
      reviewedAt: '2026-05-01T00:00:00Z',
      modelUsed: 'claude-sonnet-4-6',
      totalTokens: 0,
      totalCostUsd: 0,
      commentFingerprints: [],
    };
    const vcs = makeVCS({ getStateComment: vi.fn(async () => previousState) });
    // Rebase / force-push: computeDiffStrategy returns 'full' even
    // though previousState exists.
    const computeDiffStrategy = vi.fn<RunActionDeps['computeDiffStrategy'] & object>(
      async () => 'full',
    );
    const logger = vi.fn<NonNullable<RunActionDeps['logger']>>();
    const provider = makeProvider();
    await runAction(
      inputs,
      { ref },
      {
        readFile: async () => {
          throw new Error('no config');
        },
        createVCS: () => vcs,
        createProvider: () => provider,
        computeDiffStrategy,
        logger,
      },
    );
    const getDiffMock = vcs.getDiff as ReturnType<typeof vi.fn>;
    expect(getDiffMock).toHaveBeenCalledTimes(1);
    expect(getDiffMock.mock.calls[0]?.[1]).toBeUndefined();
    expect(logger).toHaveBeenCalledWith(
      'rebase detected',
      expect.objectContaining({ previousSha: 'orphanedHead', headSha: 'H' }),
    );
    // No incremental-context section in the prompt on the fallback path.
    const generateMock = provider.generateReview as ReturnType<typeof vi.fn>;
    const reviewInput = generateMock.mock.calls[0]?.[0] as ReviewInput | undefined;
    expect(reviewInput?.systemPrompt).not.toContain('## Incremental review');
  });

  it('retries upsertStateComment on 5xx and fails-loud after the configured budget', async () => {
    const log = vi.fn<NonNullable<RunActionDeps['logger']>>();
    const upsertStateComment = vi.fn(async () => {
      // Always throw a 503; with stateWriteRetries=2 that's 3 total
      // attempts, all of which fail → retry budget exhausted.
      throw Object.assign(new Error('service unavailable'), { status: 503 });
    });
    const vcs = makeVCS({ upsertStateComment });
    await expect(
      runAction(
        { ...inputs, stateWriteRetries: 2 },
        { ref },
        {
          readFile: async () => {
            throw new Error('no config');
          },
          createVCS: () => vcs,
          createProvider: () => makeProvider(),
          logger: log,
          sleep: noSleep,
        },
      ),
    ).rejects.toThrow(/State comment write failed after 2 retries/);
    // 2 retries = 3 total attempts.
    expect(upsertStateComment).toHaveBeenCalledTimes(3);
    // The fail-loud log includes the operator-facing warning + the
    // underlying error message captured from the last attempt.
    const messages = log.mock.calls.map((c) => c[0]);
    expect(messages).toContain(
      'State comment write failed after 2 retries; next review will be a full re-review.',
    );
    expect(messages.filter((m) => m.includes('vcs.upsertStateComment: attempt'))).toHaveLength(2);
  });

  it('does NOT retry upsertStateComment on a non-retriable 4xx (404)', async () => {
    const log = vi.fn<NonNullable<RunActionDeps['logger']>>();
    const upsertStateComment = vi.fn(async () => {
      // 404 → permissions / not-found, retrying won't help.
      throw Object.assign(new Error('not found'), { status: 404 });
    });
    const vcs = makeVCS({ upsertStateComment });
    await expect(
      runAction(
        { ...inputs, stateWriteRetries: 5 },
        { ref },
        {
          readFile: async () => {
            throw new Error('no config');
          },
          createVCS: () => vcs,
          createProvider: () => makeProvider(),
          logger: log,
          sleep: noSleep,
        },
      ),
    ).rejects.toThrow(/State comment write failed/);
    // Single attempt; no retries on 404 regardless of budget.
    expect(upsertStateComment).toHaveBeenCalledTimes(1);
  });

  it('retries postReview on transient 5xx and succeeds before exhausting the budget', async () => {
    const log = vi.fn<NonNullable<RunActionDeps['logger']>>();
    let postCall = 0;
    const postReview = vi.fn(async () => {
      postCall += 1;
      if (postCall < 3) {
        throw Object.assign(new Error('502'), { status: 502 });
      }
      // 3rd attempt succeeds.
    });
    const vcs = makeVCS({ postReview });
    const result = await runAction(
      { ...inputs, stateWriteRetries: 3 },
      { ref },
      {
        readFile: async () => {
          throw new Error('no config');
        },
        createVCS: () => vcs,
        createProvider: () => makeProvider(),
        logger: log,
        sleep: noSleep,
      },
    );
    expect(result.skipped).toBe(false);
    expect(postReview).toHaveBeenCalledTimes(3);
    expect(vcs.upsertStateComment).toHaveBeenCalledTimes(1);
  });

  it('with stateWriteRetries=0, runs a single attempt and fails on first error', async () => {
    const log = vi.fn<NonNullable<RunActionDeps['logger']>>();
    const upsertStateComment = vi.fn(async () => {
      throw Object.assign(new Error('service down'), { status: 503 });
    });
    const vcs = makeVCS({ upsertStateComment });
    await expect(
      runAction(
        { ...inputs, stateWriteRetries: 0 },
        { ref },
        {
          readFile: async () => {
            throw new Error('no config');
          },
          createVCS: () => vcs,
          createProvider: () => makeProvider(),
          logger: log,
          sleep: noSleep,
        },
      ),
    ).rejects.toThrow(/State comment write failed after 0 retries/);
    // 0 retries = 1 total attempt (no retry on failure).
    expect(upsertStateComment).toHaveBeenCalledTimes(1);
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

  // `inferGithubHost` is private but its result threads through into
  // `runReview`'s `job.prRepo.host`. The runner's `runReview` doesn't
  // expose host directly in `ReviewInput`, so we exercise the env-
  // parsing branches by running the action end-to-end with each
  // shape of `GITHUB_SERVER_URL` and asserting the success path
  // (no schema failure, no thrown error). The host's downstream
  // effect on the URL allowlist is covered by core/schemas tests.
  it('honors a GHE GITHUB_SERVER_URL when present (URL.parse branch)', async () => {
    const vcs = makeVCS();
    const provider = makeProvider();
    const result = await runAction(
      inputs,
      { ref },
      {
        readFile: async () => {
          throw new Error('no config');
        },
        createVCS: () => vcs,
        createProvider: () => provider,
        // Real GHES deployments set GITHUB_SERVER_URL to the host URL;
        // the parser should yield `ghe.example.com` rather than the
        // default `github.com`.
        env: { GITHUB_SERVER_URL: 'https://ghe.example.com' },
      },
    );
    expect(result.skipped).toBe(false);
    expect(vcs.postReview).toHaveBeenCalledTimes(1);
  });

  it('falls back to github.com when GITHUB_SERVER_URL is unparseable (catch branch)', async () => {
    const vcs = makeVCS();
    const provider = makeProvider();
    const result = await runAction(
      inputs,
      { ref },
      {
        readFile: async () => {
          throw new Error('no config');
        },
        createVCS: () => vcs,
        createProvider: () => provider,
        // `new URL('not-a-valid-url')` throws — the function must
        // catch and fall back to 'github.com' rather than propagate.
        env: { GITHUB_SERVER_URL: 'not-a-valid-url' },
      },
    );
    expect(result.skipped).toBe(false);
    expect(vcs.postReview).toHaveBeenCalledTimes(1);
  });

  // `loadConfigOrDefault` reads the REVIEW_AGENT_* env vars and
  // threads them into `mergeWithEnv`. Each env var has an `if` guard
  // — the false branches (env var absent) are covered by every other
  // test; here we cover the true branches by setting all four.
  it('threads REVIEW_AGENT_LANGUAGE / PROVIDER / MODEL / MAX_USD_PER_PR env overrides into config', async () => {
    const vcs = makeVCS();
    const provider = makeProvider();
    const result = await runAction(
      inputs,
      { ref },
      {
        readFile: async () => {
          throw new Error('no config');
        },
        createVCS: () => vcs,
        createProvider: () => provider,
        env: {
          REVIEW_AGENT_LANGUAGE: 'ja-JP',
          REVIEW_AGENT_PROVIDER: 'anthropic',
          REVIEW_AGENT_MODEL: 'claude-sonnet-4-6',
          REVIEW_AGENT_MAX_USD_PER_PR: '2.5',
        },
      },
    );
    // The action runs to completion — confirms each `if (env.X)`
    // truthy branch was taken without breaking the downstream merge.
    expect(result.skipped).toBe(false);
    // generateReview is fed the merged language so we can confirm
    // the env override actually landed in the prompt path.
    const generateMock = provider.generateReview as ReturnType<typeof vi.fn>;
    const reviewInput = generateMock.mock.calls[0]?.[0] as { language: string } | undefined;
    expect(reviewInput?.language).toBe('ja-JP');
  });

  // -------------------------------------------------------------------------
  // #152: suggestions config propagation
  // -------------------------------------------------------------------------

  it('forwards config.suggestions into the ReviewJob passed to runReview (#152)', async () => {
    // Verify that when a config with suggestions.enabled=false is loaded,
    // the LLM-facing system prompt path gets called (which means ReviewJob
    // was built and passed to the runner). We spy on generateReview to
    // capture the injected ReviewJob indirectly via the provider call.
    const generateReview = vi.fn(async () => ({
      summary: 'OK',
      comments: [],
      tokensUsed: { input: 100, output: 50 },
      costUsd: 0.001,
    }));
    const provider: ReturnType<typeof makeProvider> = {
      ...makeProvider(),
      generateReview,
    };
    const postReview = vi.fn(async () => undefined);
    const vcs = makeVCS({ postReview });
    const yaml = 'suggestions:\n  enabled: false\n';
    await runAction(
      inputs,
      { ref },
      {
        readFile: async () => yaml,
        createVCS: () => vcs,
        createProvider: () => provider,
        sleep: noSleep,
      },
    );
    // The runner was called (provider.generateReview) — means ReviewJob
    // with suggestions reached the runner.
    expect(generateReview).toHaveBeenCalledTimes(1);
    // postReview was called — means postOrUpdate ran.
    expect(postReview).toHaveBeenCalledTimes(1);
  });

  it('forwards diff into ReviewPayload.diff when calling postReview (#152)', async () => {
    // When getDiff returns files with patches, postReview must receive those
    // patches in the diff field so the GitHub adapter can do hunk validation.
    const patch = '@@ -1,3 +1,3 @@\n context\n+added at 2\n context at 3';
    const getDiff = vi.fn(async () => ({
      baseSha: 'B',
      headSha: 'H',
      files: [
        {
          path: 'src/a.ts',
          patch,
          previousPath: null,
          status: 'modified' as const,
          additions: 1,
          deletions: 0,
        },
      ],
    }));
    const postReview = vi.fn(async () => undefined);
    const vcs = makeVCS({ getDiff, postReview });
    await runAction(
      inputs,
      { ref },
      {
        readFile: async () => {
          throw new Error('no config');
        },
        createVCS: () => vcs,
        createProvider: () => makeProvider(),
        sleep: noSleep,
      },
    );
    expect(postReview).toHaveBeenCalledTimes(1);
    const payload = (postReview as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as {
      diff?: { files: Array<{ path: string; patch: string | null }> };
    };
    // diff must be forwarded with path + patch for each file.
    expect(payload.diff).toBeDefined();
    expect(payload.diff?.files).toHaveLength(1);
    expect(payload.diff?.files[0]?.path).toBe('src/a.ts');
    expect(payload.diff?.files[0]?.patch).toBe(patch);
  });

  // external_tools wiring (#160)
  it('reads sarif_path and passes externalTools to runReview when configured', async () => {
    const sarifContent = JSON.stringify({
      version: '2.1.0',
      runs: [
        {
          tool: { driver: { name: 'CodeQL', rules: [{ id: 'sql-injection' }] } },
          results: [
            {
              ruleId: 'sql-injection',
              level: 'error',
              message: { text: 'SQL injection' },
              locations: [
                {
                  physicalLocation: {
                    artifactLocation: { uri: 'src/db.ts' },
                    region: { startLine: 5 },
                  },
                },
              ],
            },
          ],
        },
      ],
    });

    const vcs = makeVCS();
    let capturedProvider: LlmProvider | null = null;

    const result = await runAction(
      inputs,
      { ref },
      {
        readFile: async (p) => {
          if (p === '.review-agent.yml') {
            return 'external_tools:\n  tools:\n    - name: codeql\n      sarif_path: results/codeql.sarif\n';
          }
          if (p === 'results/codeql.sarif') return sarifContent;
          throw new Error(`unexpected read: ${p}`);
        },
        createVCS: () => vcs,
        createProvider: (_key, _cfg) => {
          capturedProvider = makeProvider();
          return capturedProvider;
        },
        sleep: noSleep,
      },
    );

    expect(result.skipped).toBe(false);
    // The action ran to completion; the SARIF was read (no read errors logged).
    expect(vcs.postReview).toHaveBeenCalledTimes(1);
  });

  it('warns and skips when sarif_path is not readable, review still completes', async () => {
    const warnMessages: string[] = [];
    const vcs = makeVCS();

    const result = await runAction(
      inputs,
      { ref },
      {
        readFile: async (p) => {
          if (p === '.review-agent.yml') {
            return 'external_tools:\n  tools:\n    - name: codeql\n      sarif_path: missing.sarif\n';
          }
          throw new Error(`not found: ${p}`);
        },
        createVCS: () => vcs,
        createProvider: () => makeProvider(),
        logger: (msg) => {
          warnMessages.push(msg);
        },
        sleep: noSleep,
      },
    );

    expect(result.skipped).toBe(false);
    expect(vcs.postReview).toHaveBeenCalledTimes(1);
    expect(warnMessages.some((m) => m.includes('not found or unreadable'))).toBe(true);
  });
});
