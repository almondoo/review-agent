import type { PR, ReviewState, VCS } from '@review-agent/core';
import type { LlmProvider, ReviewOutput } from '@review-agent/llm';
import { describe, expect, it, vi } from 'vitest';
import { runReviewCommand } from './review.js';

function recordingIo() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    stdout: (c: string) => {
      out.push(c);
    },
    stderr: (c: string) => {
      err.push(c);
    },
    exit: () => {},
  };
}

function fakePR(overrides: Partial<PR> = {}): PR {
  return {
    ref: { platform: 'github', owner: 'o', repo: 'r', number: 1 },
    title: 'Test PR',
    body: '',
    author: 'alice',
    baseSha: 'b1',
    headSha: 'h1',
    baseRef: 'main',
    headRef: 'feat',
    draft: false,
    labels: [],
    commitMessages: [],
    createdAt: '2026-04-30T00:00:00Z',
    updatedAt: '2026-04-30T00:00:00Z',
    ...overrides,
  };
}

function fakeVcs(overrides: Partial<VCS> = {}): VCS {
  const base: VCS = {
    platform: 'github',
    capabilities: {
      clone: true,
      stateComment: 'native',
      approvalEvent: 'github',
      commitMessages: true,
    },
    getPR: async () => fakePR(),
    getDiff: async () => ({ baseSha: 'b1', headSha: 'h1', files: [] }),
    getFile: async () => Buffer.from(''),
    cloneRepo: async () => undefined,
    postReview: vi.fn(async () => undefined),
    postSummary: async () => ({ commentId: 'c1' }),
    getExistingComments: async () => [],
    getStateComment: async () => null,
    upsertStateComment: vi.fn(async () => undefined),
  };
  return { ...base, ...overrides };
}

function fakeProvider(output: Partial<ReviewOutput> = {}): LlmProvider {
  return {
    name: 'fake',
    model: 'fake-model',
    generateReview: async () => ({
      comments: [],
      summary: 'no issues',
      tokensUsed: { input: 0, output: 0 },
      costUsd: 0,
      ...output,
    }),
    estimateCost: async () => ({ inputTokens: 0, estimatedUsd: 0 }),
    pricePerMillionTokens: () => ({ input: 0, output: 0 }),
    classifyError: () => ({ kind: 'fatal' }),
  };
}

const baseEnv = { REVIEW_AGENT_GH_TOKEN: 't', ANTHROPIC_API_KEY: 'k' } as NodeJS.ProcessEnv;

describe('runReviewCommand', () => {
  it('reports auth_failed without GITHUB token', async () => {
    const io = recordingIo();
    const result = await runReviewCommand(io, {
      repo: 'o/r',
      pr: 1,
      configPath: '.review-agent.yml',
      post: false,
      env: { ANTHROPIC_API_KEY: 'k' } as NodeJS.ProcessEnv,
    });
    expect(result.status).toBe('auth_failed');
    expect(io.err.join('')).toContain('REVIEW_AGENT_GH_TOKEN');
  });

  it('reports auth_failed without ANTHROPIC_API_KEY', async () => {
    const io = recordingIo();
    const result = await runReviewCommand(io, {
      repo: 'o/r',
      pr: 1,
      configPath: '.review-agent.yml',
      post: false,
      env: { REVIEW_AGENT_GH_TOKEN: 't' } as NodeJS.ProcessEnv,
    });
    expect(result.status).toBe('auth_failed');
    expect(io.err.join('')).toContain('ANTHROPIC_API_KEY');
  });

  it('skips draft PRs when auto_review.drafts=false (default)', async () => {
    const io = recordingIo();
    const vcs = fakeVcs({ getPR: async () => fakePR({ draft: true }) });
    const result = await runReviewCommand(io, {
      repo: 'o/r',
      pr: 1,
      configPath: 'missing.yml',
      post: false,
      env: baseEnv,
      readFile: async () => {
        throw new Error('not found');
      },
      createVCS: () => vcs,
      createProvider: () => fakeProvider(),
    });
    expect(result.status).toBe('skipped');
    expect(io.out.join('')).toContain('draft');
  });

  it('runs a dry review when --post is false', async () => {
    const io = recordingIo();
    const vcs = fakeVcs();
    const result = await runReviewCommand(io, {
      repo: 'o/r',
      pr: 1,
      configPath: 'missing.yml',
      post: false,
      env: baseEnv,
      readFile: async () => {
        throw new Error('not found');
      },
      createVCS: () => vcs,
      createProvider: () => fakeProvider({ summary: 'all good' }),
    });
    expect(result.status).toBe('reviewed');
    expect(result.postedComments).toBe(0);
    expect(io.out.join('')).toContain('--post');
    expect(vcs.postReview).not.toHaveBeenCalled();
  });

  it('publishes when --post is true and confirm returns true', async () => {
    const io = recordingIo();
    const vcs = fakeVcs();
    const result = await runReviewCommand(io, {
      repo: 'o/r',
      pr: 1,
      configPath: 'missing.yml',
      post: true,
      env: baseEnv,
      readFile: async () => {
        throw new Error('not found');
      },
      createVCS: () => vcs,
      createProvider: () => fakeProvider({ summary: 'looks ok' }),
      confirm: async () => true,
    });
    expect(result.status).toBe('reviewed');
    expect(vcs.postReview).toHaveBeenCalledTimes(1);
    expect(vcs.upsertStateComment).toHaveBeenCalledTimes(1);
  });

  it('cancels when confirm returns false', async () => {
    const io = recordingIo();
    const vcs = fakeVcs();
    const result = await runReviewCommand(io, {
      repo: 'o/r',
      pr: 1,
      configPath: 'missing.yml',
      post: true,
      env: baseEnv,
      readFile: async () => {
        throw new Error('not found');
      },
      createVCS: () => vcs,
      createProvider: () => fakeProvider(),
      confirm: async () => false,
    });
    expect(result.status).toBe('cancelled');
    expect(vcs.postReview).not.toHaveBeenCalled();
  });

  it('rejects malformed --repo strings', async () => {
    const io = recordingIo();
    await expect(() =>
      runReviewCommand(io, {
        repo: 'not-valid',
        pr: 1,
        configPath: '.review-agent.yml',
        post: false,
        env: baseEnv,
      }),
    ).rejects.toThrow(/owner\/repo/);
  });

  it('honours --lang and --profile overrides', async () => {
    const io = recordingIo();
    const vcs = fakeVcs();
    const provider = fakeProvider();
    const result = await runReviewCommand(io, {
      repo: 'o/r',
      pr: 1,
      configPath: 'missing.yml',
      post: false,
      language: 'ja-JP',
      profile: 'assertive',
      costCapUsd: 0.5,
      env: baseEnv,
      readFile: async () => {
        throw new Error('not found');
      },
      createVCS: () => vcs,
      createProvider: () => provider,
      // Suppress dry-run hint-line presence checks
    });
    expect(result.status).toBe('reviewed');
  });

  it('uses an existing previous state from the VCS', async () => {
    const io = recordingIo();
    const previous: ReviewState = {
      schemaVersion: 1,
      lastReviewedSha: 'h0',
      baseSha: 'b0',
      reviewedAt: '2026-04-29T00:00:00Z',
      modelUsed: 'm',
      totalTokens: 0,
      totalCostUsd: 0,
      commentFingerprints: [],
    };
    const vcs = fakeVcs({ getStateComment: async () => previous });
    const result = await runReviewCommand(io, {
      repo: 'o/r',
      pr: 1,
      configPath: 'missing.yml',
      post: true,
      env: baseEnv,
      readFile: async () => {
        throw new Error('not found');
      },
      createVCS: () => vcs,
      createProvider: () => fakeProvider(),
      confirm: async () => true,
    });
    expect(result.status).toBe('reviewed');
  });

  it('reads .review-agent.yml from the supplied path', async () => {
    const io = recordingIo();
    const vcs = fakeVcs();
    const yaml = 'language: ja-JP\nprofile: assertive\ncost:\n  max_usd_per_pr: 0.25\n';
    const result = await runReviewCommand(io, {
      repo: 'o/r',
      pr: 1,
      configPath: '.review-agent.yml',
      post: false,
      env: baseEnv,
      readFile: async () => yaml,
      createVCS: () => vcs,
      createProvider: () => fakeProvider(),
    });
    expect(result.status).toBe('reviewed');
  });

  it('runs codecommit happy path without a GH token', async () => {
    const io = recordingIo();
    const ccVcs: VCS = {
      ...fakeVcs(),
      platform: 'codecommit',
      capabilities: {
        clone: false,
        stateComment: 'postgres-only',
        approvalEvent: 'codecommit',
        commitMessages: false,
      },
      getPR: async () =>
        fakePR({ ref: { platform: 'codecommit', owner: '', repo: 'demo', number: 42 } }),
    };
    const result = await runReviewCommand(io, {
      repo: 'demo',
      pr: 42,
      configPath: 'missing.yml',
      post: false,
      platform: 'codecommit',
      env: { ANTHROPIC_API_KEY: 'k' } as NodeJS.ProcessEnv,
      readFile: async () => {
        throw new Error('not found');
      },
      createVCS: () => ccVcs,
      createProvider: () => fakeProvider({ summary: 'ok' }),
    });
    expect(result.status).toBe('reviewed');
  });

  it('reports auth_failed when --platform codecommit is used without --repo', async () => {
    const io = recordingIo();
    const result = await runReviewCommand(io, {
      repo: '',
      pr: 42,
      configPath: 'missing.yml',
      post: false,
      platform: 'codecommit',
      env: { ANTHROPIC_API_KEY: 'k' } as NodeJS.ProcessEnv,
    });
    expect(result.status).toBe('auth_failed');
    expect(io.err.join('')).toContain('Missing required --repo for --platform codecommit');
  });

  it('rejects malformed codecommit --repo (contains slash)', async () => {
    const io = recordingIo();
    await expect(() =>
      runReviewCommand(io, {
        repo: 'owner/repo',
        pr: 1,
        configPath: 'missing.yml',
        post: false,
        platform: 'codecommit',
        env: { ANTHROPIC_API_KEY: 'k' } as NodeJS.ProcessEnv,
      }),
    ).rejects.toThrow(/codecommit/);
  });

  it('skips when author is in ignore_authors', async () => {
    const io = recordingIo();
    const yaml = 'reviews:\n  ignore_authors: ["alice"]\n';
    const vcs = fakeVcs();
    const result = await runReviewCommand(io, {
      repo: 'o/r',
      pr: 1,
      configPath: '.review-agent.yml',
      post: false,
      env: baseEnv,
      readFile: async () => yaml,
      createVCS: () => vcs,
      createProvider: () => fakeProvider(),
    });
    expect(result.status).toBe('skipped');
    expect(io.out.join('')).toContain('ignore_authors');
  });
});
