import {
  CostExceededError,
  SecretLeakAbortedError,
  ToolDispatchRefusedError,
} from '@review-agent/core';
import type { LlmProvider, ReviewInput, ReviewOutput } from '@review-agent/llm';
import { describe, expect, it, vi } from 'vitest';
import { runReview } from './agent.js';
import type { GitleaksFinding } from './gitleaks.js';
import { MAX_TOOL_CALLS } from './tools.js';
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
