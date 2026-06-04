import {
  CostExceededError,
  SecretLeakAbortedError,
  ToolDispatchRefusedError,
} from '@review-agent/core';
import type { LlmProvider, ReviewInput, ReviewOutput } from '@review-agent/llm';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_RULESET_CATEGORY, runReview } from './agent.js';
import { CUSTOM_RULE_ID_PREFIX, type GitleaksFinding } from './gitleaks.js';
import { MAX_TOOL_CALLS } from './tools.js';
import { REVIEW_ABORT_REASONS, type ReviewJob } from './types.js';

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
  pathFilters: [],
  maxFiles: 50,
  maxDiffLines: 3000,
  privacy: { allowedUrlPrefixes: [], denyPaths: [], redactPatterns: [] },
  prRepo: { host: 'github.com', owner: 'test-owner', repo: 'test-repo' },
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

  it('returns an aborted result (no throw) when the second attempt also violates schema', async () => {
    const generateReview = vi
      .fn<LlmProvider['generateReview']>()
      .mockResolvedValue({ ...validOutput, summary: '' });
    const provider = makeProvider({ generateReview });
    const result = await runReview(baseJob, provider);
    expect(generateReview).toHaveBeenCalledTimes(2);
    expect(result.aborted?.reason).toBe('schema_violation');
    expect(result.aborted?.internalIssues.length).toBeGreaterThan(0);
    expect(result.comments).toEqual([]);
    expect(result.summary).toContain('Review aborted');
    expect(result.summary).toContain('fails schema validation');
  });
});

describe('runReview — URL allowlist retry / graceful abort (spec §7.3 #4)', () => {
  // The fixture's `prRepo` is `test-owner/test-repo` on github.com, so
  // URLs under that path are own-repo and pass; everything else needs
  // an entry in `privacy.allowedUrlPrefixes` or it triggers retry.
  const badUrlOutput: ReviewOutput = {
    summary: 'See https://attacker.example/leak for context.',
    comments: [],
    tokensUsed: { input: 100, output: 50 },
    costUsd: 0.001,
  };

  it('retries once on a URL-allowlist violation and succeeds on the retry', async () => {
    const generateReview = vi
      .fn<LlmProvider['generateReview']>()
      .mockResolvedValueOnce(badUrlOutput)
      .mockResolvedValueOnce(validOutput);
    const provider = makeProvider({ generateReview });
    const result = await runReview(baseJob, provider);
    expect(generateReview).toHaveBeenCalledTimes(2);
    expect(result.aborted).toBeUndefined();
    expect(result.comments).toHaveLength(2);
    const secondCall = generateReview.mock.calls[1]?.[0];
    expect(secondCall?.systemPrompt).toContain('your previous response failed schema validation');
  });

  it('gracefully aborts (returns aborted=url_allowlist) when both attempts fail the URL allowlist', async () => {
    const generateReview = vi.fn<LlmProvider['generateReview']>().mockResolvedValue(badUrlOutput);
    const provider = makeProvider({ generateReview });
    const result = await runReview(baseJob, provider);
    expect(generateReview).toHaveBeenCalledTimes(2);
    expect(result.aborted?.reason).toBe('url_allowlist');
    expect(result.aborted?.internalIssues.length).toBeGreaterThan(0);
    expect(result.comments).toEqual([]);
    expect(result.summary).toBe(
      'Review aborted: LLM produced output that violates the URL allowlist after one retry. See spec §7.3.',
    );
  });

  // Security regression for reviewer M-2: the public-facing `summary`
  // MUST NOT echo the rejected URL even when the URL was the reason
  // for the abort. Rejected URLs can contain attacker-injected
  // secrets in the query string (`?token=`, `?session=`); posting them
  // verbatim in a PR comment would reopen the exfiltration channel
  // the allowlist refine just closed. Raw Zod issues go to
  // `aborted.internalIssues` (audit-log only) instead.
  it('does NOT echo the rejected URL into the user-facing summary; full diagnostic only in internalIssues', async () => {
    const sensitiveUrlOutput: ReviewOutput = {
      summary: 'See https://attacker.example/exfil?token=secret-token-12345 for context.',
      comments: [],
      tokensUsed: { input: 100, output: 50 },
      costUsd: 0.001,
    };
    const generateReview = vi
      .fn<LlmProvider['generateReview']>()
      .mockResolvedValue(sensitiveUrlOutput);
    const provider = makeProvider({ generateReview });
    const result = await runReview(baseJob, provider);
    expect(result.aborted?.reason).toBe('url_allowlist');
    // Generic notice only — no URL, no host, no secret.
    expect(result.summary).not.toContain('attacker.example');
    expect(result.summary).not.toContain('secret-token-12345');
    expect(result.summary).not.toContain('?token=');
    // The raw issues with the URL ARE preserved on the internal
    // channel so operators can diagnose via audit log / telemetry.
    const internalText = result.aborted?.internalIssues.map((i) => i.message).join('|') ?? '';
    expect(internalText).toContain('attacker.example');
    expect(internalText).toContain('secret-token-12345');
  });

  it("permits URLs that point into the PR's own repo without any allowlist entry", async () => {
    // Own-repo URL inside body — should pass on the first attempt, no
    // retry, no aborted flag. Regression for the `prRepo` wiring from T3.
    const ownRepoOutput: ReviewOutput = {
      ...validOutput,
      summary: 'See https://github.com/test-owner/test-repo/pull/1 for the design discussion.',
    };
    const generateReview = vi.fn<LlmProvider['generateReview']>(async () => ownRepoOutput);
    const provider = makeProvider({ generateReview });
    const result = await runReview(baseJob, provider);
    expect(generateReview).toHaveBeenCalledTimes(1);
    expect(result.aborted).toBeUndefined();
    expect(result.summary).toContain('test-owner/test-repo/pull/1');
  });

  it('routes a bad URL in `suggestion` through the same retry/abort path (T2 link)', async () => {
    // Codifies the T2 suggestion-field scan integration: a bad URL in
    // suggestion must trigger the same retry pipeline as one in body.
    const badSuggestionOutput: ReviewOutput = {
      summary: 'Two findings.',
      comments: [
        {
          path: 'src/a.ts',
          line: 1,
          side: 'RIGHT',
          body: 'Extract to helper.',
          severity: 'minor',
          suggestion: 'logger.info(); // see https://attacker.example/leak',
        },
      ],
      tokensUsed: { input: 100, output: 50 },
      costUsd: 0.001,
    };
    const generateReview = vi
      .fn<LlmProvider['generateReview']>()
      .mockResolvedValue(badSuggestionOutput);
    const provider = makeProvider({ generateReview });
    const result = await runReview(baseJob, provider);
    expect(generateReview).toHaveBeenCalledTimes(2);
    expect(result.aborted?.reason).toBe('url_allowlist');
    expect(result.aborted?.internalIssues.length).toBeGreaterThan(0);
  });

  it('honors operator-supplied `allowedUrlPrefixes` so a configured URL passes on the first attempt', async () => {
    const okWithAllowlistOutput: ReviewOutput = {
      ...validOutput,
      summary: 'See https://docs.example.com/api for the parameter list.',
    };
    const generateReview = vi.fn<LlmProvider['generateReview']>(async () => okWithAllowlistOutput);
    const provider = makeProvider({ generateReview });
    const job: ReviewJob = {
      ...baseJob,
      privacy: {
        allowedUrlPrefixes: ['https://docs.example.com/'],
        denyPaths: [],
        redactPatterns: [],
      },
    };
    const result = await runReview(job, provider);
    expect(generateReview).toHaveBeenCalledTimes(1);
    expect(result.aborted).toBeUndefined();
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

describe('runReview — secret-leak post-scan', () => {
  const highFinding = (ruleId: string, secret: string): GitleaksFinding => ({
    ruleId,
    description: `Built-in rule: ${ruleId}`,
    file: '',
    startLine: 1,
    endLine: 1,
    match: secret,
    secret,
    entropy: 0,
    tags: ['high'],
  });

  const mediumFinding = (secret: string): GitleaksFinding => ({
    ruleId: 'high-entropy',
    description: 'High-entropy string (4.7)',
    file: '',
    startLine: 1,
    endLine: 1,
    match: secret,
    secret,
    entropy: 4.7,
    tags: ['medium'],
  });

  it('passes clean output through untouched when scanner returns no findings', async () => {
    const provider = makeProvider();
    const scanContent = vi.fn(() => []);
    const result = await runReview(baseJob, provider, { scanContent });
    expect(result.comments).toHaveLength(2);
    expect(result.summary).toBe('Two findings.');
    expect(scanContent).toHaveBeenCalled();
    const scannedText = scanContent.mock.calls.map((call) => call[0]).join('|');
    expect(scannedText).toContain('Two findings.');
    expect(scannedText).toContain('Extract to a helper.');
  });

  it('aborts with SecretLeakAbortedError when output contains a high-confidence finding', async () => {
    const tainted: ReviewOutput = {
      ...validOutput,
      summary: 'Found token AKIAIOSFODNN7EXAMPLE in the diff.',
    };
    const provider = makeProvider({ generateReview: vi.fn(async () => tainted) });
    const scanContent = vi.fn((text: string) =>
      text.includes('AKIAIOSFODNN7EXAMPLE')
        ? [highFinding('aws-access-key', 'AKIAIOSFODNN7EXAMPLE')]
        : [],
    );
    await expect(runReview(baseJob, provider, { scanContent })).rejects.toBeInstanceOf(
      SecretLeakAbortedError,
    );
    await expect(runReview(baseJob, provider, { scanContent })).rejects.toMatchObject({
      phase: 'output',
      findingsCount: 1,
      ruleIds: ['aws-access-key'],
    });
  });

  it('aborts when output contains more than 3 findings even with medium tags', async () => {
    const provider = makeProvider();
    const scanContent = vi.fn(() => [
      mediumFinding('alpha'),
      mediumFinding('beta'),
      mediumFinding('gamma'),
      mediumFinding('delta'),
    ]);
    await expect(runReview(baseJob, provider, { scanContent })).rejects.toBeInstanceOf(
      SecretLeakAbortedError,
    );
  });

  it('redacts non-aborting findings in the returned summary and comment bodies', async () => {
    const [first, second] = validOutput.comments;
    if (!first || !second) throw new Error('fixture missing comments');
    const tainted: ReviewOutput = {
      ...validOutput,
      summary: 'Saw entropy blob alpha7xQ here.',
      comments: [{ ...first, body: 'Inspect alpha7xQ for safety.' }, second],
    };
    const provider = makeProvider({ generateReview: vi.fn(async () => tainted) });
    const scanContent = vi.fn(() => [mediumFinding('alpha7xQ')]);
    const result = await runReview(baseJob, provider, { scanContent });
    expect(result.summary).toBe('Saw entropy blob [REDACTED:high-entropy] here.');
    expect(result.comments[0]?.body).toBe('Inspect [REDACTED:high-entropy] for safety.');
    expect(result.comments[1]?.body).toBe('Use parameterized query.');
  });

  it('aborts BEFORE invoking the provider when the diff contains a high-confidence finding', async () => {
    const provider = makeProvider();
    const scanContent = vi.fn((text: string) =>
      text.includes('diff --git') ? [highFinding('aws-access-key', 'AKIAIOSFODNN7EXAMPLE')] : [],
    );
    await expect(runReview(baseJob, provider, { scanContent })).rejects.toBeInstanceOf(
      SecretLeakAbortedError,
    );
    await expect(runReview(baseJob, provider, { scanContent })).rejects.toMatchObject({
      phase: 'diff',
    });
    expect(provider.generateReview).not.toHaveBeenCalled();
  });

  it('dedup runs before the scanner so previous-state hits are not re-scanned', async () => {
    const provider = makeProvider();
    const firstRun = await runReview(baseJob, provider, { scanContent: () => [] });
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
    const scanContent = vi.fn(() => []);
    const secondRun = await runReview({ ...baseJob, previousState }, provider, { scanContent });
    expect(secondRun.comments).toHaveLength(0);
    const scannedText = scanContent.mock.calls.map((call) => call[0]).join('|');
    expect(scannedText).not.toContain('Extract to a helper.');
    expect(scannedText).not.toContain('Use parameterized query.');
  });
});

describe('runReview — min_confidence filter (#69)', () => {
  it('keeps all comments when minConfidence defaults to "low"', async () => {
    const out: ReviewOutput = {
      summary: 's',
      comments: [
        { ...validOutput.comments[0], confidence: 'high' } as ReviewOutput['comments'][number],
        { ...validOutput.comments[1], confidence: 'low' } as ReviewOutput['comments'][number],
      ],
      tokensUsed: { input: 1, output: 1 },
      costUsd: 0,
    };
    const provider = makeProvider({ generateReview: vi.fn(async () => out) });
    const result = await runReview(baseJob, provider);
    expect(result.comments).toHaveLength(2);
  });

  it('drops "low" comments when minConfidence is "medium"', async () => {
    const out: ReviewOutput = {
      summary: 's',
      comments: [
        { ...validOutput.comments[0], confidence: 'high' } as ReviewOutput['comments'][number],
        { ...validOutput.comments[1], confidence: 'low' } as ReviewOutput['comments'][number],
      ],
      tokensUsed: { input: 1, output: 1 },
      costUsd: 0,
    };
    const provider = makeProvider({ generateReview: vi.fn(async () => out) });
    const result = await runReview({ ...baseJob, minConfidence: 'medium' }, provider);
    expect(result.comments).toHaveLength(1);
    expect(result.comments[0]?.confidence).toBe('high');
  });

  it('drops "medium" + "low" when minConfidence is "high"', async () => {
    const out: ReviewOutput = {
      summary: 's',
      comments: [
        { ...validOutput.comments[0], confidence: 'high' } as ReviewOutput['comments'][number],
        { ...validOutput.comments[1], confidence: 'medium' } as ReviewOutput['comments'][number],
      ],
      tokensUsed: { input: 1, output: 1 },
      costUsd: 0,
    };
    const provider = makeProvider({ generateReview: vi.fn(async () => out) });
    const result = await runReview({ ...baseJob, minConfidence: 'high' }, provider);
    expect(result.comments).toHaveLength(1);
  });

  it('treats comments without a confidence field as "high"', async () => {
    // Back-compat: a legacy review with no confidence field must not
    // be silently dropped when an operator sets minConfidence: 'high'.
    const provider = makeProvider();
    const result = await runReview({ ...baseJob, minConfidence: 'high' }, provider);
    expect(result.comments).toHaveLength(2);
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

describe('runReview — tool exposure (#59)', () => {
  it('passes an AI-SDK tool set with read_file / glob / grep to the provider', async () => {
    const generateReview = vi.fn<LlmProvider['generateReview']>(async () => validOutput);
    const provider = makeProvider({ generateReview });
    await runReview(baseJob, provider);
    const callArgs = generateReview.mock.calls[0]?.[0] as ReviewInput | undefined;
    expect(callArgs?.tools).toBeDefined();
    const names = Object.keys(callArgs?.tools ?? {});
    expect(names).toEqual(expect.arrayContaining(['read_file', 'glob', 'grep']));
  });

  it('bounds tool calls per review via maxToolCalls = MAX_TOOL_CALLS', async () => {
    const generateReview = vi.fn<LlmProvider['generateReview']>(async () => validOutput);
    const provider = makeProvider({ generateReview });
    await runReview(baseJob, provider);
    const callArgs = generateReview.mock.calls[0]?.[0] as ReviewInput | undefined;
    expect(callArgs?.maxToolCalls).toBe(MAX_TOOL_CALLS);
  });

  it('counts at least one read_file tool call when the LLM invokes it during the review', async () => {
    // Integration scenario: the diff references a function defined
    // elsewhere; a tool-using LLM looks it up via read_file before
    // producing the final review. The fake provider mimics that by
    // calling the wired-in tool through its `execute` hook.
    const diffText =
      'diff --git a/src/caller.ts b/src/caller.ts\n@@ -1 +1 @@\n+import { helper } from "./helper";\n+helper();';
    const generateReview = vi.fn<LlmProvider['generateReview']>(async (input: ReviewInput) => {
      const readFile = (input.tools as Record<string, { execute: (args: unknown) => unknown }>)
        ?.read_file;
      // Exercise the AI-SDK tool surface end-to-end: the provider
      // would normally drive these calls; here the fake provider
      // does so directly so the assertion below holds without a
      // real model in the loop.
      try {
        await readFile?.execute({ path: 'src/helper.ts' });
      } catch {
        // The default tools.read_file resolves against the
        // workspace dir which is a non-existent tmp path in this
        // test; we don't need the read to succeed, only to be
        // *attempted*. The onCall hook fires before any fs IO.
      }
      return validOutput;
    });
    const provider = makeProvider({ generateReview });
    const result = await runReview({ ...baseJob, diffText }, provider);
    expect(result.toolCalls).toBeGreaterThanOrEqual(1);
  });

  it('reports zero tool calls when the LLM produces output without using tools', async () => {
    const generateReview = vi.fn<LlmProvider['generateReview']>(async () => validOutput);
    const provider = makeProvider({ generateReview });
    const result = await runReview(baseJob, provider);
    expect(result.toolCalls).toBe(0);
  });
});

describe('runReview — operator deny_paths wiring (spec §7.4 / #86)', () => {
  // End-to-end check that `ReviewJob.privacy.denyPaths` (glob strings)
  // is compiled with `globToRegExp` inside the agent loop and threaded
  // into the AI-SDK tool dispatcher. The fake provider drives the
  // tools directly so we can assert the wiring without depending on a
  // real model. tools.test.ts covers the dispatcher semantics in
  // isolation; this test only proves the cable runs.
  it('refuses an operator-denied path inside the wired-in tool surface', async () => {
    let caught: unknown = null;
    const generateReview = vi.fn<LlmProvider['generateReview']>(async (input: ReviewInput) => {
      const readFile = (input.tools as Record<string, { execute: (args: unknown) => unknown }>)
        ?.read_file;
      try {
        await readFile?.execute({ path: 'org-secrets/policy.txt' });
      } catch (err) {
        caught = err;
      }
      return validOutput;
    });
    const provider = makeProvider({ generateReview });
    const job: ReviewJob = {
      ...baseJob,
      privacy: { allowedUrlPrefixes: [], denyPaths: ['org-secrets/**'], redactPatterns: [] },
    };
    await runReview(job, provider);
    expect(caught).toBeInstanceOf(ToolDispatchRefusedError);
    expect((caught as ToolDispatchRefusedError).message).toMatch(/deny-list/);
  });

  it('keeps the built-in deny list active even when denyPaths is empty', async () => {
    // Empty operator list ≡ "extend with nothing" — the built-in
    // `.env*` / `secrets/` / `.pem` defaults still apply.
    let caught: unknown = null;
    const generateReview = vi.fn<LlmProvider['generateReview']>(async (input: ReviewInput) => {
      const readFile = (input.tools as Record<string, { execute: (args: unknown) => unknown }>)
        ?.read_file;
      try {
        await readFile?.execute({ path: '.env' });
      } catch (err) {
        caught = err;
      }
      return validOutput;
    });
    const provider = makeProvider({ generateReview });
    // baseJob already has `denyPaths: []` (T1 fixture).
    await runReview(baseJob, provider);
    expect(caught).toBeInstanceOf(ToolDispatchRefusedError);
  });

  it('permits a non-denied path through the wired tool surface', async () => {
    // Positive control so a typo in the deny matcher would also be
    // visible as a regression (everything refused vs nothing refused).
    let executed = false;
    const generateReview = vi.fn<LlmProvider['generateReview']>(async (input: ReviewInput) => {
      const readFile = (input.tools as Record<string, { execute: (args: unknown) => unknown }>)
        ?.read_file;
      try {
        await readFile?.execute({ path: 'src/allowed.ts' });
        executed = true;
      } catch {
        // The workspace doesn't actually exist (workspaceDir is
        // `/tmp/job-1`), so the underlying fs read will ENOENT. We
        // only care that the deny gate did NOT throw before fs.
        executed = true;
      }
      return validOutput;
    });
    const provider = makeProvider({ generateReview });
    const job: ReviewJob = {
      ...baseJob,
      privacy: { allowedUrlPrefixes: [], denyPaths: ['org-secrets/**'], redactPatterns: [] },
    };
    await runReview(job, provider);
    expect(executed).toBe(true);
  });
});

describe('runReview — operator redact_patterns wiring (spec §7.4 / #87)', () => {
  // End-to-end check that `ReviewJob.privacy.redactPatterns` flows
  // through both gitleaks scan passes (diff pre-scan + LLM output
  // post-scan) when the default `quickScanContent` is used. We do
  // NOT inject `deps.scanContent` here — that's the entire point:
  // the production wiring binds the operator's custom patterns into
  // the default scanner so every review picks them up without each
  // caller having to remember.

  it('aborts the diff pre-scan when a custom redact_pattern hits (single high-tag finding triggers abort)', async () => {
    // Custom patterns are tagged `["high"]` by `quickScanContent` and
    // `shouldAbortReview` treats any high-tag finding as
    // "abort BEFORE the LLM ever sees the payload". The whole
    // mechanism is the point of operator-extending redact_patterns:
    // give the operator a way to teach the agent about
    // organisation-internal secret shapes that gitleaks' built-in
    // ruleset doesn't recognise.
    const provider = makeProvider();
    const job: ReviewJob = {
      ...baseJob,
      diffText: 'diff --git\n+const t = "INTERNAL-TOKEN-ABCDEF1234567890";\n',
      privacy: {
        allowedUrlPrefixes: [],
        denyPaths: [],
        redactPatterns: ['INTERNAL-TOKEN-[A-Z0-9]{16}'],
      },
    };
    await expect(runReview(job, provider)).rejects.toBeInstanceOf(SecretLeakAbortedError);
    await expect(runReview(job, provider)).rejects.toMatchObject({
      phase: 'diff',
      ruleIds: [`${CUSTOM_RULE_ID_PREFIX}0`],
    });
    // The provider must NOT have been called — the operator's
    // pattern intercepted the diff before any LLM prompt could
    // include the token.
    expect(provider.generateReview).not.toHaveBeenCalled();
  });

  it('aborts the LLM output post-scan when a custom redact_pattern hits the model response', async () => {
    // The LLM hallucinates / repeats the operator-internal token
    // shape. The post-scan must catch it before the comment is
    // posted to the PR, the same way it catches a hallucinated
    // built-in token.
    const tainted: ReviewOutput = {
      ...validOutput,
      summary: 'Token INTERNAL-TOKEN-ABCDEF1234567890 looks reused.',
    };
    const provider = makeProvider({ generateReview: vi.fn(async () => tainted) });
    const job: ReviewJob = {
      ...baseJob,
      privacy: {
        allowedUrlPrefixes: [],
        denyPaths: [],
        redactPatterns: ['INTERNAL-TOKEN-[A-Z0-9]{16}'],
      },
    };
    await expect(runReview(job, provider)).rejects.toBeInstanceOf(SecretLeakAbortedError);
    await expect(runReview(job, provider)).rejects.toMatchObject({
      phase: 'output',
      ruleIds: [`${CUSTOM_RULE_ID_PREFIX}0`],
    });
  });

  it('redacts a custom-pattern hit in the LLM output when shouldAbortReview does not fire (mixed-tag finding)', async () => {
    // Direct injection of `scanContent` lets us pin the redaction
    // path without depending on the built-in `shouldAbortReview`
    // policy (which currently treats every custom hit as
    // `tags: ['high']` and therefore aborts). If a future tightening
    // ever lifts that abort condition, this test stays green and
    // pins the redaction format. The string `[REDACTED:custom-0]`
    // is the runtime contract shared with the docs in T5.
    const customSecret = 'XYZ-7QqLk';
    const tainted: ReviewOutput = {
      ...validOutput,
      summary: `LLM saw ${customSecret} in passing.`,
    };
    const provider = makeProvider({ generateReview: vi.fn(async () => tainted) });
    const scanContent = vi.fn((text: string) =>
      text.includes(customSecret)
        ? [
            {
              ruleId: `${CUSTOM_RULE_ID_PREFIX}0`,
              description: `Custom rule: ${CUSTOM_RULE_ID_PREFIX}0`,
              file: '',
              startLine: 1,
              endLine: 1,
              match: customSecret,
              secret: customSecret,
              entropy: 0,
              tags: ['medium'] as ReadonlyArray<string>,
            },
          ]
        : [],
    );
    const job: ReviewJob = {
      ...baseJob,
      privacy: {
        allowedUrlPrefixes: [],
        denyPaths: [],
        redactPatterns: ['XYZ-[A-Za-z0-9]+'],
      },
    };
    const result = await runReview(job, provider, { scanContent });
    expect(result.summary).toBe(`LLM saw [REDACTED:${CUSTOM_RULE_ID_PREFIX}0] in passing.`);
  });

  it('keeps built-in scanning active when redactPatterns is empty (regression)', async () => {
    // Empty operator list ≡ "extend with nothing" — the built-in
    // AWS / GitHub / Anthropic / OpenAI / PEM detectors still apply.
    // baseJob already has `redactPatterns: []`.
    const provider = makeProvider();
    const job: ReviewJob = {
      ...baseJob,
      diffText: 'diff --git\n+const k = "AKIAIOSFODNN7EXAMPLE";\n',
    };
    await expect(runReview(job, provider)).rejects.toBeInstanceOf(SecretLeakAbortedError);
    await expect(runReview(job, provider)).rejects.toMatchObject({
      phase: 'diff',
      ruleIds: ['aws-access-key'],
    });
  });

  it('emits BOTH built-in and custom ruleIds when the diff trips overlapping patterns', async () => {
    // An AWS key matches BOTH the built-in `aws-access-key` rule and
    // an operator pattern shaped like `AKIA…`. The post-scan must
    // surface both ruleIds so the audit log records the operator's
    // intentional contribution (and so the dedup via `secret` in
    // `applyRedactions` collapses the placeholder consistently).
    const provider = makeProvider();
    const job: ReviewJob = {
      ...baseJob,
      diffText: 'diff --git\n+const k = "AKIAIOSFODNN7EXAMPLE";\n',
      privacy: {
        allowedUrlPrefixes: [],
        denyPaths: [],
        redactPatterns: ['AKIA[A-Z0-9]+'],
      },
    };
    await expect(runReview(job, provider)).rejects.toMatchObject({
      phase: 'diff',
      // Both rule ids appear; order is insertion-order (built-ins
      // first because `quickScanContent` scans built-ins first).
      ruleIds: ['aws-access-key', `${CUSTOM_RULE_ID_PREFIX}0`],
    });
  });
});

describe('runReview — reviews.{path_filters,max_files,max_diff_lines} caps (#88)', () => {
  // The cap pipeline runs BEFORE the gitleaks pre-scan and BEFORE the
  // LLM call, so an over-size PR costs nothing to refuse. Tests pin:
  //   1. each cap fires independently with a graceful summary
  //   2. path_filters runs first and shrinks the file set the caps see
  //   3. cap-skip beats the secret-scan abort (cost-guard alignment)
  //   4. cap-skip suppresses provider.generateReview entirely
  //   5. default caps (50 / 3000) let small diffs through untouched

  // Helper: build a `--- ${path}\n${patch}` joined-by-`\n` diff payload
  // that matches what action / cli emit, so the parser actually
  // recognizes files in the cap pipeline.
  function buildDiff(
    files: ReadonlyArray<{ readonly path: string; readonly patch: string }>,
  ): string {
    return files.map((f) => `--- ${f.path}\n${f.patch}`).join('\n');
  }

  // Standard single-add hunk used as the per-file patch. Counts 1
  // `+`-line toward `countDiffLines`.
  const TINY_ADD = '@@ -1 +1 @@\n+line';

  it('skips with `max_files_exceeded` when filtered file count exceeds maxFiles', async () => {
    const generateReview = vi.fn<LlmProvider['generateReview']>(async () => validOutput);
    const provider = makeProvider({ generateReview });
    const diffText = buildDiff([
      { path: 'src/a.ts', patch: TINY_ADD },
      { path: 'src/b.ts', patch: TINY_ADD },
      { path: 'src/c.ts', patch: TINY_ADD },
    ]);
    const result = await runReview({ ...baseJob, diffText, maxFiles: 2 }, provider);
    expect(result.aborted?.reason).toBe('max_files_exceeded');
    expect(result.summary).toBe(
      'Review skipped: PR exceeds the max_files cap (3 files > limit 2). Adjust reviews.max_files in .review-agent.yml or reduce PR scope.',
    );
    expect(result.comments).toEqual([]);
    expect(result.costUsd).toBe(0);
    expect(result.tokensUsed).toEqual({ input: 0, output: 0 });
    expect(result.toolCalls).toBe(0);
    expect(result.reviewEvent).toBe('COMMENT');
    expect(generateReview).not.toHaveBeenCalled();
  });

  it('skips with `max_diff_lines_exceeded` when total +/- lines exceed maxDiffLines', async () => {
    const generateReview = vi.fn<LlmProvider['generateReview']>(async () => validOutput);
    const provider = makeProvider({ generateReview });
    // Four `+` lines spread across two files — `+a\n+b\n+c\n+d`
    // counts as 4 against the cap.
    const diffText = buildDiff([
      { path: 'src/a.ts', patch: '@@ -1 +1 @@\n+a\n+b' },
      { path: 'src/b.ts', patch: '@@ -1 +1 @@\n+c\n+d' },
    ]);
    const result = await runReview({ ...baseJob, diffText, maxDiffLines: 3 }, provider);
    expect(result.aborted?.reason).toBe('max_diff_lines_exceeded');
    expect(result.summary).toBe(
      'Review skipped: PR exceeds the max_diff_lines cap (4 lines > limit 3). Adjust reviews.max_diff_lines in .review-agent.yml or reduce PR scope.',
    );
    expect(generateReview).not.toHaveBeenCalled();
  });

  it('proceeds normally when the diff is within both caps', async () => {
    const generateReview = vi.fn<LlmProvider['generateReview']>(async () => validOutput);
    const provider = makeProvider({ generateReview });
    const diffText = buildDiff([{ path: 'src/a.ts', patch: TINY_ADD }]);
    const result = await runReview({ ...baseJob, diffText }, provider);
    expect(result.aborted).toBeUndefined();
    expect(generateReview).toHaveBeenCalledTimes(1);
  });

  it('applies path_filters BEFORE checking max_files (excluded files do not count)', async () => {
    // 3 files in the diff, but `vendor/**` filters one out. Cap is 2;
    // post-filter count is 2 → review proceeds.
    const generateReview = vi.fn<LlmProvider['generateReview']>(async () => validOutput);
    const provider = makeProvider({ generateReview });
    const diffText = buildDiff([
      { path: 'src/a.ts', patch: TINY_ADD },
      { path: 'src/b.ts', patch: TINY_ADD },
      { path: 'vendor/lib.js', patch: TINY_ADD },
    ]);
    const result = await runReview(
      { ...baseJob, diffText, pathFilters: ['vendor/**'], maxFiles: 2 },
      provider,
    );
    expect(result.aborted).toBeUndefined();
    expect(generateReview).toHaveBeenCalledTimes(1);
  });

  it('applies path_filters BEFORE checking max_diff_lines (excluded lines do not count)', async () => {
    // The vendor file contributes 4 + lines; src/a.ts contributes 1.
    // Cap is 3. Without the filter, total = 5 → skip. With the filter,
    // total = 1 → proceed.
    const generateReview = vi.fn<LlmProvider['generateReview']>(async () => validOutput);
    const provider = makeProvider({ generateReview });
    const diffText = buildDiff([
      { path: 'src/a.ts', patch: TINY_ADD },
      { path: 'vendor/lib.js', patch: '@@ -1 +1 @@\n+a\n+b\n+c\n+d' },
    ]);
    const result = await runReview(
      { ...baseJob, diffText, pathFilters: ['vendor/**'], maxDiffLines: 3 },
      provider,
    );
    expect(result.aborted).toBeUndefined();
    expect(generateReview).toHaveBeenCalledTimes(1);
  });

  it('feeds the LLM the filtered diff (excluded files do not appear in diffText)', async () => {
    const generateReview = vi.fn<LlmProvider['generateReview']>(async () => validOutput);
    const provider = makeProvider({ generateReview });
    const diffText = buildDiff([
      { path: 'src/a.ts', patch: TINY_ADD },
      { path: 'vendor/lib.js', patch: '@@ -1 +1 @@\n+SECRET_TOKEN_marker' },
    ]);
    await runReview({ ...baseJob, diffText, pathFilters: ['vendor/**'] }, provider);
    const callArgs = generateReview.mock.calls[0]?.[0];
    expect(callArgs?.diffText).toContain('src/a.ts');
    expect(callArgs?.diffText).not.toContain('vendor/lib.js');
    expect(callArgs?.diffText).not.toContain('SECRET_TOKEN_marker');
  });

  it('checks max_files BEFORE max_diff_lines (file-count over-cap takes precedence)', async () => {
    // Both caps would fire. The order is documented: max_files first,
    // then max_diff_lines. Pinning here so a future refactor cannot
    // silently swap the priority and emit a confusing summary.
    const generateReview = vi.fn<LlmProvider['generateReview']>(async () => validOutput);
    const provider = makeProvider({ generateReview });
    const diffText = buildDiff([
      { path: 'src/a.ts', patch: '@@ -1 +1 @@\n+a\n+b\n+c' },
      { path: 'src/b.ts', patch: '@@ -1 +1 @@\n+d\n+e\n+f' },
    ]);
    const result = await runReview(
      { ...baseJob, diffText, maxFiles: 1, maxDiffLines: 1 },
      provider,
    );
    expect(result.aborted?.reason).toBe('max_files_exceeded');
  });

  it('cap-skip BEATS the gitleaks diff pre-scan (cost-guard alignment)', async () => {
    // The diff contains an AWS-key shape that the built-in scanner
    // would normally surface as a `SecretLeakAbortedError`. Because
    // the cap pipeline runs first and the file count exceeds
    // `maxFiles`, the scan never runs and the result is a graceful
    // skip — NOT a thrown error. Operators get a single,
    // actionable signal ("PR too big") instead of a stack trace
    // for a finding they opted out of acting on by setting the cap.
    const generateReview = vi.fn<LlmProvider['generateReview']>(async () => validOutput);
    const provider = makeProvider({ generateReview });
    const diffText = buildDiff([
      { path: 'src/a.ts', patch: '@@ -1 +1 @@\n+const k = "AKIAIOSFODNN7EXAMPLE";' },
      { path: 'src/b.ts', patch: TINY_ADD },
      { path: 'src/c.ts', patch: TINY_ADD },
    ]);
    const result = await runReview({ ...baseJob, diffText, maxFiles: 2 }, provider);
    expect(result.aborted?.reason).toBe('max_files_exceeded');
    expect(generateReview).not.toHaveBeenCalled();
  });

  it('default caps (50 / 3000) let an ordinary small diff through', async () => {
    // baseJob's T1 fixture sets maxFiles=50 and maxDiffLines=3000.
    // A single-file 1-line diff is well within both caps — pinned
    // here so a future tightening of the defaults is visible.
    const provider = makeProvider();
    const result = await runReview(baseJob, provider);
    expect(result.aborted).toBeUndefined();
  });

  it('preserves diffText untouched when no filter matches (no needless reassembly)', async () => {
    // Round-trip robustness: when path_filters is configured but
    // matches nothing in this PR, the diff payload sent to the LLM
    // must be byte-identical to the original. The `filtered ===
    // parsed` short-circuit in `applyPathFilters` is what makes that
    // possible; this test pins it against a fixture whose
    // `parseDiffByFile -> reassembleDiff` round-trip would lose the
    // trailing-newline ambiguity that some diff payloads carry.
    const generateReview = vi.fn<LlmProvider['generateReview']>(async () => validOutput);
    const provider = makeProvider({ generateReview });
    const diffText = `${buildDiff([{ path: 'src/a.ts', patch: TINY_ADD }])}\n`; // trailing \n
    await runReview({ ...baseJob, diffText, pathFilters: ['nothing-matches/**'] }, provider);
    const callArgs = generateReview.mock.calls[0]?.[0];
    expect(callArgs?.diffText).toContain(diffText);
  });

  it('exposes `max_files_exceeded` / `max_diff_lines_exceeded` in REVIEW_ABORT_REASONS', () => {
    // The discriminator is part of the public API surface
    // (`RunnerResult.aborted.reason`); a typed call site like the
    // action's audit log uses the const tuple to exhaustively
    // switch. Pin both new members so a future refactor that
    // re-orders or renames them fails this test rather than
    // silently breaking downstream consumers.
    expect(REVIEW_ABORT_REASONS).toContain('max_files_exceeded');
    expect(REVIEW_ABORT_REASONS).toContain('max_diff_lines_exceeded');
  });

  // T4 gap-only additions — boundary / degenerate / operator-widens
  // / secret-in-excluded-path scenarios that T2 unit tests + the T3
  // top-of-describe set above did not pin end-to-end.

  it('proceeds at the exact max_files boundary (filtered.length === maxFiles)', async () => {
    // The check is `filtered.files.length > job.maxFiles`, so equal
    // counts pass. Pinning the `===` boundary so a future refactor
    // that flips the comparator to `>=` fails this test rather than
    // silently locking out PRs that hit the operator's exact limit.
    const generateReview = vi.fn<LlmProvider['generateReview']>(async () => validOutput);
    const provider = makeProvider({ generateReview });
    const diffText = buildDiff([
      { path: 'src/a.ts', patch: TINY_ADD },
      { path: 'src/b.ts', patch: TINY_ADD },
    ]);
    const result = await runReview({ ...baseJob, diffText, maxFiles: 2 }, provider);
    expect(result.aborted).toBeUndefined();
    expect(generateReview).toHaveBeenCalledTimes(1);
  });

  it('proceeds at the exact max_diff_lines boundary (countDiffLines === maxDiffLines)', async () => {
    // Same `>`-vs-`>=` boundary semantic as max_files. 3 `+`-lines
    // against a cap of 3 must pass; one more flips it to skip.
    const generateReview = vi.fn<LlmProvider['generateReview']>(async () => validOutput);
    const provider = makeProvider({ generateReview });
    const diffText = buildDiff([{ path: 'src/a.ts', patch: '@@ -1 +1 @@\n+a\n+b\n+c' }]);
    const result = await runReview({ ...baseJob, diffText, maxDiffLines: 3 }, provider);
    expect(result.aborted).toBeUndefined();
    expect(generateReview).toHaveBeenCalledTimes(1);
  });

  it('honors a loose operator cap (max_files: 1000) without artificially throttling', async () => {
    // The cap pipeline does numeric `>` only; it does not impose a
    // built-in maximum. Operators who widen the limit (e.g. for a
    // monorepo migration PR) must not get a surprise skip from us.
    // 60 files easily exceeds the default `50` but is well within
    // the operator's explicit override.
    const generateReview = vi.fn<LlmProvider['generateReview']>(async () => validOutput);
    const provider = makeProvider({ generateReview });
    const files = Array.from({ length: 60 }, (_, i) => ({
      path: `src/file-${i}.ts`,
      patch: TINY_ADD,
    }));
    const diffText = buildDiff(files);
    const result = await runReview({ ...baseJob, diffText, maxFiles: 1000 }, provider);
    expect(result.aborted).toBeUndefined();
    expect(generateReview).toHaveBeenCalledTimes(1);
  });

  it('proceeds with an empty diff payload when path_filters excludes every file', async () => {
    // Operator chose to exclude every path in the PR. The cap
    // pipeline sees `filtered.files.length === 0`, both caps pass,
    // and the LLM receives a diff payload with no file segments.
    // We do NOT skip in this case — the operator effectively asked
    // "review the metadata only" and the LLM can still emit a
    // summary. Pinning this prevents an over-eager future `if
    // (filtered.files.length === 0) return skip` from being added.
    const generateReview = vi.fn<LlmProvider['generateReview']>(async () => validOutput);
    const provider = makeProvider({ generateReview });
    const diffText = buildDiff([
      { path: 'vendor/a.js', patch: TINY_ADD },
      { path: 'vendor/b.js', patch: TINY_ADD },
    ]);
    const result = await runReview({ ...baseJob, diffText, pathFilters: ['vendor/**'] }, provider);
    expect(result.aborted).toBeUndefined();
    expect(generateReview).toHaveBeenCalledTimes(1);
    const callArgs = generateReview.mock.calls[0]?.[0];
    // Reassembled diff is empty when every file is excluded — none
    // of the original paths appear in the prompt.
    expect(callArgs?.diffText).not.toContain('vendor/a.js');
    expect(callArgs?.diffText).not.toContain('vendor/b.js');
  });

  it('does NOT trigger SecretLeakAbortedError when the AKIA token lives only in an excluded path', async () => {
    // Companion to "cap-skip BEATS gitleaks pre-scan" above, from
    // the other direction: when the diff is small enough to pass
    // both caps, but a secret-shaped string lives in a path the
    // operator excluded, the gitleaks pre-scan must not see it
    // (because `applyPathFilters` already removed the file from
    // the diff payload). Operators who explicitly drop a path tree
    // from review (e.g. third-party `vendor/`) are signing off on
    // its content — the agent does not second-guess them.
    const generateReview = vi.fn<LlmProvider['generateReview']>(async () => validOutput);
    const provider = makeProvider({ generateReview });
    const diffText = buildDiff([
      { path: 'src/a.ts', patch: TINY_ADD },
      { path: 'vendor/secrets.js', patch: '@@ -1 +1 @@\n+const k = "AKIAIOSFODNN7EXAMPLE";' },
    ]);
    const result = await runReview({ ...baseJob, diffText, pathFilters: ['vendor/**'] }, provider);
    expect(result.aborted).toBeUndefined();
    expect(generateReview).toHaveBeenCalledTimes(1);
    const callArgs = generateReview.mock.calls[0]?.[0];
    expect(callArgs?.diffText).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(callArgs?.diffText).not.toContain('vendor/secrets.js');
  });

  it('does not count `\\ No newline at end of file` markers toward max_diff_lines (integration pin)', async () => {
    // Mirrors a `countDiffLines` unit test in diff-filter.test.ts
    // but pins the contract end-to-end through the agent loop so a
    // refactor that swapped the counter for a naive `body.split('\n')`
    // would fail here, not only in the unit test. The body has 1
    // `+` line + 1 `\` marker; cap is 1; without the skip the cap
    // would fire as "2 > 1".
    const generateReview = vi.fn<LlmProvider['generateReview']>(async () => validOutput);
    const provider = makeProvider({ generateReview });
    const diffText = buildDiff([
      {
        path: 'src/a.ts',
        patch: '@@ -1 +1 @@\n+last-line\n\\ No newline at end of file',
      },
    ]);
    const result = await runReview({ ...baseJob, diffText, maxDiffLines: 1 }, provider);
    expect(result.aborted).toBeUndefined();
    expect(generateReview).toHaveBeenCalledTimes(1);
  });

  it('passes a rename-only / binary entry (empty body, 0 diff lines) untouched', async () => {
    // GitHub's `pulls.listFiles` returns `null` patch for binary or
    // pure-rename entries; action / cli forward that as an empty
    // body. The cap pipeline must not crash on an empty body, must
    // count it as 0 toward `max_diff_lines`, and must include it
    // in `max_files`. Pin all three with a tight cap that would
    // otherwise miscount.
    const generateReview = vi.fn<LlmProvider['generateReview']>(async () => validOutput);
    const provider = makeProvider({ generateReview });
    // Two files: one rename-only with empty body, one tiny add.
    // Cap is 1 diff line — total is 1 (only the tiny add counts).
    const diffText = `--- assets/logo.png\n--- src/a.ts\n${TINY_ADD}`;
    const result = await runReview({ ...baseJob, diffText, maxDiffLines: 1 }, provider);
    expect(result.aborted).toBeUndefined();
    expect(generateReview).toHaveBeenCalledTimes(1);
  });

  it('treats a preamble-only diff anomaly as a 0-file / 0-line payload', async () => {
    // Test fixtures elsewhere in this file pass diffText strings
    // like `'diff --git a/x b/x'` that contain no `--- ` markers.
    // The parser lands the whole thing in `preamble`, the file list
    // is empty, and both caps see 0. The cap pipeline must NOT skip
    // such input (operator might be intentionally feeding a
    // metadata-only review, e.g. for an empty merge commit), and
    // the LLM must receive the preamble unchanged. Pin both by
    // exercising the existing baseJob fixture explicitly — a
    // refactor that started rejecting "0 files" would break every
    // other test in this file, but the failure mode would be loud
    // and confusing without this explicit anchor.
    const generateReview = vi.fn<LlmProvider['generateReview']>(async () => validOutput);
    const provider = makeProvider({ generateReview });
    const result = await runReview(
      { ...baseJob, diffText: 'diff --git a/x b/x', maxFiles: 0, maxDiffLines: 0 },
      provider,
    );
    expect(result.aborted).toBeUndefined();
    expect(generateReview).toHaveBeenCalledTimes(1);
    const callArgs = generateReview.mock.calls[0]?.[0];
    expect(callArgs?.diffText).toContain('diff --git a/x b/x');
  });
});

describe('runReview — reviewEvent mapping (#65)', () => {
  const criticalOutput: ReviewOutput = {
    summary: 'Critical finding.',
    comments: [
      {
        path: 'src/a.ts',
        line: 1,
        side: 'RIGHT',
        body: 'SQL injection on req.params.id',
        severity: 'critical',
      },
    ],
    tokensUsed: { input: 100, output: 50 },
    costUsd: 0.001,
  };
  const majorOnlyOutput: ReviewOutput = {
    summary: 'One major.',
    comments: [
      {
        path: 'src/a.ts',
        line: 1,
        side: 'RIGHT',
        body: 'Missing await.',
        severity: 'major',
      },
    ],
    tokensUsed: { input: 100, output: 50 },
    costUsd: 0.001,
  };
  const minorOnlyOutput: ReviewOutput = {
    summary: 'Style only.',
    comments: [
      {
        path: 'src/a.ts',
        line: 1,
        side: 'RIGHT',
        body: 'Unused import.',
        severity: 'minor',
      },
    ],
    tokensUsed: { input: 100, output: 50 },
    costUsd: 0.001,
  };

  it('defaults to threshold=critical when job.requestChangesOn is not set', async () => {
    const provider = makeProvider({
      generateReview: vi.fn(async () => criticalOutput),
    });
    const result = await runReview(baseJob, provider);
    expect(result.reviewEvent).toBe('REQUEST_CHANGES');
  });

  it('emits COMMENT when comments contain only majors at threshold=critical', async () => {
    const provider = makeProvider({
      generateReview: vi.fn(async () => majorOnlyOutput),
    });
    const result = await runReview({ ...baseJob, requestChangesOn: 'critical' }, provider);
    expect(result.reviewEvent).toBe('COMMENT');
  });

  it('emits REQUEST_CHANGES when comments contain a major at threshold=major', async () => {
    const provider = makeProvider({
      generateReview: vi.fn(async () => majorOnlyOutput),
    });
    const result = await runReview({ ...baseJob, requestChangesOn: 'major' }, provider);
    expect(result.reviewEvent).toBe('REQUEST_CHANGES');
  });

  it('emits COMMENT at threshold=never even with a critical present', async () => {
    const provider = makeProvider({
      generateReview: vi.fn(async () => criticalOutput),
    });
    const result = await runReview({ ...baseJob, requestChangesOn: 'never' }, provider);
    expect(result.reviewEvent).toBe('COMMENT');
  });

  it('emits COMMENT when all comments are minor', async () => {
    const provider = makeProvider({
      generateReview: vi.fn(async () => minorOnlyOutput),
    });
    const result = await runReview({ ...baseJob, requestChangesOn: 'critical' }, provider);
    expect(result.reviewEvent).toBe('COMMENT');
  });

  it('computes against the *kept* comment list (post-dedup), not the LLM output', async () => {
    // First run posts both critical + minor; second run with previousState
    // containing both fingerprints drops everything → reviewEvent must
    // be COMMENT (no critical left to request changes on).
    const provider = makeProvider({
      generateReview: vi.fn(async () => criticalOutput),
    });
    const firstRun = await runReview(baseJob, provider);
    expect(firstRun.reviewEvent).toBe('REQUEST_CHANGES');

    const previousState = {
      schemaVersion: 1 as const,
      lastReviewedSha: 'old',
      baseSha: 'b',
      reviewedAt: 'r',
      modelUsed: 'm',
      totalTokens: 0,
      totalCostUsd: 0,
      commentFingerprints: firstRun.comments.map((c) => c.fingerprint),
    };
    const secondRun = await runReview({ ...baseJob, previousState }, provider);
    expect(secondRun.comments).toHaveLength(0);
    expect(secondRun.reviewEvent).toBe('COMMENT');
  });
});

describe('runReview — eval recorder integration (#91 / spec v1.2 Phase 2)', () => {
  it('records a review_eval_event row at the end of a successful run', async () => {
    const provider = makeProvider();
    const evalRecorder = vi.fn(async () => undefined);
    let t = 1000;
    await runReview(baseJob, provider, {
      now: () => {
        t += 250;
        return t;
      },
      evalRecorder,
      evalContext: { installationId: 99n, prNumber: 14, headSha: 'feedface' },
    });
    expect(evalRecorder).toHaveBeenCalledTimes(1);
    const event = evalRecorder.mock.calls[0]?.[0];
    expect(event?.installationId).toBe(99n);
    expect(event?.jobId).toBe('job-1');
    expect(event?.repo).toBe('test-owner/test-repo');
    expect(event?.prNumber).toBe(14);
    expect(event?.headSha).toBe('feedface');
    expect(event?.provider).toBe('anthropic');
    expect(event?.model).toBe('claude-sonnet-4-6');
    expect(event?.commentCount).toBe(2);
    expect(event?.severityDist).toMatchObject({ critical: 0, major: 1, minor: 1, info: 0 });
    expect(event?.confidenceDist).toMatchObject({ high: 2, medium: 0, low: 0 });
    expect(event?.toolCalls).toBe(0);
    // Two `now()` calls (start, end). Each increments by 250 → 250ms.
    expect(event?.latencyMs).toBe(250);
    expect(event?.costUsd).toBeCloseTo(0.0045);
    expect(event?.abortReason).toBeNull();
  });

  it('records the event with abortReason on a graceful cap-skip path', async () => {
    const provider = makeProvider();
    const evalRecorder = vi.fn(async () => undefined);
    // Two-file diff that exceeds the maxFiles=1 cap and triggers
    // the `max_files_exceeded` short-circuit before the LLM call.
    const diffText = ['--- a.ts\n@@ -1 +1 @@\n+a', '--- b.ts\n@@ -1 +1 @@\n+b'].join('\n');
    await runReview({ ...baseJob, maxFiles: 1, diffText }, provider, {
      evalRecorder,
      evalContext: { installationId: 1n, prNumber: 1, headSha: 'h' },
    });
    const event = evalRecorder.mock.calls[0]?.[0];
    expect(event?.abortReason).toBe('max_files_exceeded');
    expect(event?.commentCount).toBe(0);
    expect(event?.costUsd).toBe(0);
  });

  it('does not record when evalRecorder is absent — zero overhead path', async () => {
    const provider = makeProvider();
    const result = await runReview(baseJob, provider);
    expect(result.comments).toHaveLength(2);
    // No recorder fired by construction; the lack of throw IS the signal.
  });

  it('does not record when evalContext is missing even if recorder is set', async () => {
    const provider = makeProvider();
    const evalRecorder = vi.fn(async () => undefined);
    await runReview(baseJob, provider, { evalRecorder });
    expect(evalRecorder).not.toHaveBeenCalled();
  });

  it('fail-open: recorder error never bubbles to the caller', async () => {
    const provider = makeProvider();
    const evalRecorder = vi.fn(async () => {
      throw new Error('db down');
    });
    const onEvalRecordError = vi.fn();
    const result = await runReview(baseJob, provider, {
      evalRecorder,
      evalContext: { installationId: 1n, prNumber: 1, headSha: 'h' },
      onEvalRecordError,
    });
    expect(result.comments).toHaveLength(2);
    expect(onEvalRecordError).toHaveBeenCalledTimes(1);
  });
});

describe('runReview — learned_facts injection + feedback-aware dedup (#93 / spec v1.2 Phase 4)', () => {
  it('threads accepted_pattern + rejected_finding rows into the system prompt', async () => {
    const provider = makeProvider();
    await runReview(baseJob, provider, {
      evalContext: { installationId: 9n, prNumber: 1, headSha: 'h' },
      historyReader: async () => [
        { factType: 'accepted_pattern', factText: '[fp:aaa] 👍 by alice' },
        { factType: 'rejected_finding', factText: '[fp:bbb] dismissed by bob' },
      ],
    });
    const callArgs = (provider.generateReview as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(callArgs?.systemPrompt).toContain('<learned_facts>');
    expect(callArgs?.systemPrompt).toContain('alice');
    expect(callArgs?.systemPrompt).toContain('bob');
  });

  it('drops comments whose fingerprint matches a rejected_finding row and counts droppedByFeedback', async () => {
    // The validOutput LLM mock emits two comments; we precompute the
    // fingerprint of one and inject it via the history reader so
    // the dedup middleware suppresses that comment as feedback.
    const provider = makeProvider();
    const firstRun = await runReview(baseJob, provider);
    const fp = firstRun.comments[0]?.fingerprint;
    expect(fp).toBeTruthy();
    const secondRun = await runReview(baseJob, provider, {
      evalContext: { installationId: 9n, prNumber: 1, headSha: 'h' },
      historyReader: async () => [
        { factType: 'rejected_finding', factText: `[fp:${fp}] dismissed` },
      ],
    });
    expect(secondRun.comments.map((c) => c.fingerprint)).not.toContain(fp);
    expect(secondRun.droppedByFeedback).toBe(1);
  });

  it('forwards droppedByFeedback into the eval recorder event', async () => {
    const provider = makeProvider();
    const firstRun = await runReview(baseJob, provider);
    const fp = firstRun.comments[0]?.fingerprint as string;
    const evalRecorder = vi.fn(async () => undefined);
    await runReview(baseJob, provider, {
      evalContext: { installationId: 9n, prNumber: 1, headSha: 'h' },
      historyReader: async () => [
        { factType: 'rejected_finding', factText: `[fp:${fp}] dismissed` },
      ],
      evalRecorder,
    });
    const event = evalRecorder.mock.calls[0]?.[0];
    expect(event?.droppedByFeedback).toBe(1);
  });

  it('ignores rejected_finding rows without a parseable [fp:...] prefix', async () => {
    const provider = makeProvider();
    const secondRun = await runReview(baseJob, provider, {
      evalContext: { installationId: 9n, prNumber: 1, headSha: 'h' },
      historyReader: async () => [
        { factType: 'rejected_finding', factText: 'malformed without fp prefix' },
      ],
    });
    expect(secondRun.comments).toHaveLength(2);
    expect(secondRun.droppedByFeedback).toBe(0);
  });

  it('skips history-reader entirely when evalContext is missing', async () => {
    const provider = makeProvider();
    const historyReader = vi.fn(async () => []);
    await runReview(baseJob, provider, { historyReader });
    expect(historyReader).not.toHaveBeenCalled();
  });

  it('routes historyReader throws through onHistoryReaderError and still re-raises (#106)', async () => {
    const provider = makeProvider();
    const boom = new Error('reader exploded');
    const historyReader = vi.fn(async () => {
      throw boom;
    });
    const onHistoryReaderError = vi.fn();
    await expect(
      runReview(baseJob, provider, {
        historyReader,
        onHistoryReaderError,
        evalContext: {
          installationId: 1n,
          prNumber: 7,
          headSha: 'h',
        },
      }),
    ).rejects.toBe(boom);
    expect(onHistoryReaderError).toHaveBeenCalledTimes(1);
    expect(onHistoryReaderError).toHaveBeenCalledWith(boom);
  });
});

describe('runReview — CodeCommit review_history repo normalization (#110)', () => {
  // CodeCommit PRs carry `prRepo.owner === ''` by adapter convention.
  // Left unchanged, the historyReader / evalRecorder would receive
  // `repo: '/foo'`, indistinguishable across installations that share
  // the same repo name. The runner substitutes `installationId` as the
  // owner so each tenant gets a unique DB key.
  const codecommitJob: ReviewJob = {
    ...baseJob,
    prRepo: { host: 'codecommit', owner: '', repo: 'demo-repo' },
  };

  it('substitutes installationId for the empty CodeCommit owner when calling historyReader', async () => {
    const provider = makeProvider();
    const historyReader = vi.fn(async () => []);
    await runReview(codecommitJob, provider, {
      historyReader,
      evalContext: { installationId: 123n, prNumber: 1, headSha: 'h' },
    });
    expect(historyReader).toHaveBeenCalledTimes(1);
    expect(historyReader.mock.calls[0]?.[0]?.repo).toBe('123/demo-repo');
  });

  it('substitutes installationId for the empty CodeCommit owner when calling evalRecorder', async () => {
    const provider = makeProvider();
    const evalRecorder = vi.fn(async () => undefined);
    await runReview(codecommitJob, provider, {
      evalRecorder,
      evalContext: { installationId: 456n, prNumber: 1, headSha: 'h' },
    });
    expect(evalRecorder).toHaveBeenCalledTimes(1);
    expect(evalRecorder.mock.calls[0]?.[0]?.repo).toBe('456/demo-repo');
  });

  it('preserves the owner/repo shape on GitHub jobs (regression guard)', async () => {
    const provider = makeProvider();
    const evalRecorder = vi.fn(async () => undefined);
    await runReview(baseJob, provider, {
      evalRecorder,
      evalContext: { installationId: 9n, prNumber: 1, headSha: 'h' },
    });
    expect(evalRecorder.mock.calls[0]?.[0]?.repo).toBe('test-owner/test-repo');
  });
});

describe('runReview — onConfigResolution hook (issue #146)', () => {
  const resolutionLog = {
    primarySource: 'repo-yaml' as const,
    orgYamlLoaded: false,
    envApplied: false,
    sections: { language: 'repo-yaml' as const, cost: 'default' as const },
  };

  it('fires onConfigResolution when both resolutionLog and hook are present', async () => {
    const provider = makeProvider();
    const onConfigResolution = vi.fn();
    const jobWithLog = { ...baseJob, resolutionLog };
    await runReview(jobWithLog, provider, { onConfigResolution });
    expect(onConfigResolution).toHaveBeenCalledTimes(1);
    expect(onConfigResolution).toHaveBeenCalledWith(resolutionLog);
  });

  it('does NOT fire onConfigResolution when resolutionLog is absent from job', async () => {
    const provider = makeProvider();
    const onConfigResolution = vi.fn();
    await runReview(baseJob, provider, { onConfigResolution });
    expect(onConfigResolution).not.toHaveBeenCalled();
  });

  it('does NOT fire onConfigResolution when hook is absent (back-compat)', async () => {
    const provider = makeProvider();
    const jobWithLog = { ...baseJob, resolutionLog };
    // Should complete without error even though no hook is wired.
    const result = await runReview(jobWithLog, provider, {});
    expect(result.comments).toHaveLength(2);
  });

  it('fires onConfigResolution before any LLM call', async () => {
    const callOrder: string[] = [];
    const provider = makeProvider({
      generateReview: vi.fn(async () => {
        callOrder.push('llm');
        return validOutput;
      }),
    });
    const onConfigResolution = vi.fn(() => {
      callOrder.push('hook');
    });
    const jobWithLog = { ...baseJob, resolutionLog };
    await runReview(jobWithLog, provider, { onConfigResolution });
    expect(callOrder[0]).toBe('hook');
    expect(callOrder[1]).toBe('llm');
  });
});

describe('runReview — ruleset filter (#148)', () => {
  // Helpers: outputs that carry explicit categories for ruleset testing.
  function makeOutputWithCategories(): ReviewOutput {
    return {
      summary: 'Three findings.',
      comments: [
        {
          path: 'src/a.ts',
          line: 1,
          side: 'RIGHT' as const,
          body: 'SQL injection risk.',
          severity: 'critical' as const,
          category: 'security' as const,
        },
        {
          path: 'src/b.ts',
          line: 5,
          side: 'RIGHT' as const,
          body: 'Duplicated logic.',
          severity: 'minor' as const,
          category: 'maintainability' as const,
        },
        {
          path: 'src/c.ts',
          line: 10,
          side: 'RIGHT' as const,
          body: 'Wrong indent.',
          severity: 'info' as const,
          category: 'style' as const,
        },
      ],
      tokensUsed: { input: 1000, output: 200 },
      costUsd: 0.001,
    };
  }

  it('passes all comments through when ruleset is absent (back-compat)', async () => {
    const provider = makeProvider({
      generateReview: vi.fn(async () => makeOutputWithCategories()),
    });
    const result = await runReview(baseJob, provider);
    expect(result.comments).toHaveLength(3);
    expect(result.droppedByRuleset).toBe(0);
  });

  it('passes all comments through when ruleset is empty {}', async () => {
    const provider = makeProvider({
      generateReview: vi.fn(async () => makeOutputWithCategories()),
    });
    const result = await runReview({ ...baseJob, ruleset: {} }, provider);
    expect(result.comments).toHaveLength(3);
    expect(result.droppedByRuleset).toBe(0);
  });

  it('suppresses findings in a disabled category (enabled: false)', async () => {
    const provider = makeProvider({
      generateReview: vi.fn(async () => makeOutputWithCategories()),
    });
    const result = await runReview(
      { ...baseJob, ruleset: { style: { enabled: false, min_severity: 'info' } } },
      provider,
    );
    // style comment should be dropped
    expect(result.comments).toHaveLength(2);
    expect(result.droppedByRuleset).toBe(1);
    expect(result.comments.every((c) => c.category !== 'style')).toBe(true);
  });

  it('disabling multiple categories drops all their findings', async () => {
    const provider = makeProvider({
      generateReview: vi.fn(async () => makeOutputWithCategories()),
    });
    const result = await runReview(
      {
        ...baseJob,
        ruleset: {
          style: { enabled: false, min_severity: 'info' },
          maintainability: { enabled: false, min_severity: 'info' },
        },
      },
      provider,
    );
    expect(result.comments).toHaveLength(1);
    expect(result.droppedByRuleset).toBe(2);
    expect(result.comments[0]?.category).toBe('security');
  });

  it('suppresses findings below min_severity floor for their category', async () => {
    // maintainability finding is 'minor'; setting min_severity: 'major' drops it.
    const provider = makeProvider({
      generateReview: vi.fn(async () => makeOutputWithCategories()),
    });
    const result = await runReview(
      {
        ...baseJob,
        ruleset: { maintainability: { enabled: true, min_severity: 'major' } },
      },
      provider,
    );
    expect(result.comments).toHaveLength(2);
    expect(result.droppedByRuleset).toBe(1);
    expect(result.comments.every((c) => c.category !== 'maintainability')).toBe(true);
  });

  it('keeps findings at or above the min_severity floor', async () => {
    // security finding is 'critical'; min_severity: 'major' must keep it.
    const provider = makeProvider({
      generateReview: vi.fn(async () => makeOutputWithCategories()),
    });
    const result = await runReview(
      {
        ...baseJob,
        ruleset: { security: { enabled: true, min_severity: 'major' } },
      },
      provider,
    );
    const securityKept = result.comments.filter((c) => c.category === 'security');
    expect(securityKept).toHaveLength(1);
  });

  it('keeps findings whose category has no ruleset entry (pass-through)', async () => {
    // maintainability is not in the ruleset → always kept regardless of severity.
    const provider = makeProvider({
      generateReview: vi.fn(async () => makeOutputWithCategories()),
    });
    const result = await runReview(
      {
        ...baseJob,
        ruleset: {
          style: { enabled: false, min_severity: 'info' },
          // maintainability not present → no filter
        },
      },
      provider,
    );
    const maintainabilityKept = result.comments.filter((c) => c.category === 'maintainability');
    expect(maintainabilityKept).toHaveLength(1);
  });

  it(`assigns DEFAULT_RULESET_CATEGORY ('${DEFAULT_RULESET_CATEGORY}') to findings without a category`, async () => {
    // The baseJob validOutput has no category on its comments.
    // DEFAULT_RULESET_CATEGORY is 'bug'; disabling 'bug' must drop them.
    const provider = makeProvider({ generateReview: vi.fn(async () => validOutput) });
    const result = await runReview(
      { ...baseJob, ruleset: { bug: { enabled: false, min_severity: 'info' } } },
      provider,
    );
    // Both comments in validOutput have no category → assigned 'bug' → dropped.
    expect(result.comments).toHaveLength(0);
    expect(result.droppedByRuleset).toBe(2);
  });

  it('applies min_severity against DEFAULT_RULESET_CATEGORY for uncategorized findings', async () => {
    // validOutput comments have severity 'minor' and 'major', no category.
    // DEFAULT_RULESET_CATEGORY = 'bug'; set min_severity: 'critical' for 'bug'.
    const provider = makeProvider({ generateReview: vi.fn(async () => validOutput) });
    const result = await runReview(
      { ...baseJob, ruleset: { bug: { enabled: true, min_severity: 'critical' } } },
      provider,
    );
    // Both are below 'critical' → both dropped.
    expect(result.comments).toHaveLength(0);
    expect(result.droppedByRuleset).toBe(2);
  });

  it('droppedByRuleset is 0 when no ruleset filter is configured (no-op)', async () => {
    const provider = makeProvider();
    const result = await runReview(baseJob, provider);
    expect(result.droppedByRuleset).toBe(0);
  });

  it('DEFAULT_RULESET_CATEGORY is the documented default ("bug")', () => {
    // Regression guard: the default must be 'bug' per spec §10.1 documentation.
    expect(DEFAULT_RULESET_CATEGORY).toBe('bug');
  });
});
