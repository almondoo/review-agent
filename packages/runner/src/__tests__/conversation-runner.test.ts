import { createFakeVCS } from '@review-agent/core';
import { describe, expect, it, vi } from 'vitest';
import {
  type ConversationReplyInput,
  type ConversationRunnerDeps,
  handleConversationReply,
} from '../conversation-runner.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProvider(overrides: Partial<ReturnType<typeof makeProvider>> = {}) {
  const generateReview = vi.fn().mockResolvedValue({
    comments: [],
    summary: 'Great question! This is a SQL injection risk.',
    tokensUsed: { input: 100, output: 50 },
    costUsd: 0.001,
    toolCalls: 0,
  });
  return {
    name: 'fake',
    model: 'fake-model',
    generateReview,
    estimateCost: vi.fn().mockResolvedValue({ inputTokens: 100, estimatedUsd: 0.001 }),
    pricePerMillionTokens: vi.fn().mockReturnValue({ input: 3, output: 15 }),
    classifyError: vi.fn().mockReturnValue({ kind: 'fatal' }),
    ...overrides,
  };
}

const baseRef = { platform: 'github' as const, owner: 'o', repo: 'r', number: 42 };

const baseInput: ConversationReplyInput = {
  ref: baseRef,
  rootCommentId: 100,
  installationId: BigInt(11),
  repo: 'o/r',
  prNumber: 42,
  context: {
    findingBody: 'This looks like a SQL injection risk.',
    diffHunk: '@@ -1,3 +1,4 @@\n+const q = db.query("SELECT * FROM users WHERE id=" + id)',
    priorTurns: [],
    userMessage: 'Hey @review-agent, is this actually a bug?',
  },
  maxConversationTurns: 5,
  costCapUsd: 1.0,
  costRecordContext: { jobId: 'job-1', provider: 'fake', model: 'fake-model' },
};

function makeIncrementTurn(turnCountAfter = 1) {
  return vi.fn().mockResolvedValue({
    turnCountBefore: turnCountAfter - 1,
    turnCountAfter,
  });
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('handleConversationReply', () => {
  it('happy path: calls LLM, posts reply, returns replied', async () => {
    const postReply = vi.fn().mockResolvedValue(undefined);
    const vcs = createFakeVCS({ postReply });
    const provider = makeProvider();
    const incrementTurn = makeIncrementTurn(1);
    const deps: ConversationRunnerDeps = { vcs, provider, incrementTurn };

    const result = await handleConversationReply(baseInput, deps);

    expect(result.kind).toBe('replied');
    if (result.kind === 'replied') {
      expect(result.body).toContain('SQL injection');
    }
    expect(incrementTurn).toHaveBeenCalledOnce();
    expect(provider.generateReview).toHaveBeenCalledOnce();
    expect(postReply).toHaveBeenCalledWith(baseRef, 100, expect.any(String));
  });

  it('happy path: includes prior turns in context prompt', async () => {
    const postReply = vi.fn().mockResolvedValue(undefined);
    const vcs = createFakeVCS({ postReply });
    const provider = makeProvider();
    const incrementTurn = makeIncrementTurn(1);
    const deps: ConversationRunnerDeps = { vcs, provider, incrementTurn };

    const inputWithHistory: ConversationReplyInput = {
      ...baseInput,
      context: {
        ...baseInput.context,
        priorTurns: [
          { author: 'bot', body: 'This is a SQL injection risk.' },
          { author: 'alice', body: 'Can you explain more?' },
        ],
      },
    };

    await handleConversationReply(inputWithHistory, deps);

    const callArg = provider.generateReview.mock.calls[0]?.[0];
    expect(callArg?.diffText).toContain('thread_history');
    expect(callArg?.diffText).toContain('bot');
    expect(callArg?.diffText).toContain('Can you explain more');
  });

  it('records cost when recordCost and costRecordContext are provided', async () => {
    const postReply = vi.fn().mockResolvedValue(undefined);
    const vcs = createFakeVCS({ postReply });
    const provider = makeProvider();
    const incrementTurn = makeIncrementTurn(1);
    const recordCost = vi.fn().mockResolvedValue(undefined);
    const deps: ConversationRunnerDeps = { vcs, provider, incrementTurn, recordCost };

    await handleConversationReply(baseInput, deps);

    expect(recordCost).toHaveBeenCalledOnce();
    const costCall = recordCost.mock.calls[0]?.[0];
    expect(costCall.callPhase).toBe('review_main');
    expect(costCall.status).toBe('success');
    expect(costCall.costUsd).toBeGreaterThan(0);
  });

  it('skips cost recording when recordCost is not provided', async () => {
    const postReply = vi.fn().mockResolvedValue(undefined);
    const vcs = createFakeVCS({ postReply });
    const provider = makeProvider();
    const incrementTurn = makeIncrementTurn(1);
    // No recordCost in deps
    const deps: ConversationRunnerDeps = { vcs, provider, incrementTurn };

    const result = await handleConversationReply(baseInput, deps);
    expect(result.kind).toBe('replied');
  });
});

// ---------------------------------------------------------------------------
// Self-reply guard (handled in webhook layer, not runner layer)
// The runner is only called after the webhook guard has already fired.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Turn limit
// ---------------------------------------------------------------------------

describe('handleConversationReply — turn limit (#149)', () => {
  it('posts limit-reached note and returns turn_limit_reached when count > max', async () => {
    const postReply = vi.fn().mockResolvedValue(undefined);
    const vcs = createFakeVCS({ postReply });
    const provider = makeProvider();
    // turnCountAfter = 6 > maxConversationTurns = 5 → first overflow
    const incrementTurn = makeIncrementTurn(6);
    const deps: ConversationRunnerDeps = { vcs, provider, incrementTurn };

    const result = await handleConversationReply({ ...baseInput, maxConversationTurns: 5 }, deps);

    expect(result.kind).toBe('turn_limit_reached');
    expect(provider.generateReview).not.toHaveBeenCalled();
    // Limit note should be posted exactly once (first overflow)
    expect(postReply).toHaveBeenCalledOnce();
    const [, , noteBody] = postReply.mock.calls[0] ?? [];
    expect(String(noteBody)).toContain('conversation limit');
  });

  it('does NOT post another limit note on subsequent overflow turns (turnCountAfter > max+1)', async () => {
    const postReply = vi.fn().mockResolvedValue(undefined);
    const vcs = createFakeVCS({ postReply });
    const provider = makeProvider();
    // turnCountAfter = 7 (second overflow turn — limit note was already posted)
    const incrementTurn = makeIncrementTurn(7);
    const deps: ConversationRunnerDeps = { vcs, provider, incrementTurn };

    const result = await handleConversationReply({ ...baseInput, maxConversationTurns: 5 }, deps);

    expect(result.kind).toBe('turn_limit_reached');
    expect(provider.generateReview).not.toHaveBeenCalled();
    // No note on subsequent overflow (only first overflow posts the note)
    expect(postReply).not.toHaveBeenCalled();
  });

  it('succeeds on the last allowed turn (turnCountAfter === maxConversationTurns)', async () => {
    const postReply = vi.fn().mockResolvedValue(undefined);
    const vcs = createFakeVCS({ postReply });
    const provider = makeProvider();
    const incrementTurn = makeIncrementTurn(5); // exactly at max
    const deps: ConversationRunnerDeps = { vcs, provider, incrementTurn };

    const result = await handleConversationReply({ ...baseInput, maxConversationTurns: 5 }, deps);

    expect(result.kind).toBe('replied');
    expect(provider.generateReview).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// Cost cap
// ---------------------------------------------------------------------------

describe('handleConversationReply — cost cap (#149)', () => {
  it('returns cost_exceeded when running cost is at or above PR cap', async () => {
    const postReply = vi.fn().mockResolvedValue(undefined);
    const vcs = createFakeVCS({ postReply });
    const provider = makeProvider();
    const incrementTurn = makeIncrementTurn(1);
    // readTotals reports running = 1.5 which is >= costCapUsd 1.0
    const readTotals = vi.fn().mockResolvedValue({ running: 1.5, daily: 0 });
    const deps: ConversationRunnerDeps = { vcs, provider, incrementTurn, readTotals };

    const result = await handleConversationReply({ ...baseInput, costCapUsd: 1.0 }, deps);

    expect(result.kind).toBe('cost_exceeded');
    expect(provider.generateReview).not.toHaveBeenCalled();
    expect(postReply).not.toHaveBeenCalled();
  });

  it('proceeds when running cost is below PR cap', async () => {
    const postReply = vi.fn().mockResolvedValue(undefined);
    const vcs = createFakeVCS({ postReply });
    const provider = makeProvider();
    const incrementTurn = makeIncrementTurn(1);
    const readTotals = vi.fn().mockResolvedValue({ running: 0.1, daily: 0 });
    const deps: ConversationRunnerDeps = { vcs, provider, incrementTurn, readTotals };

    const result = await handleConversationReply({ ...baseInput, costCapUsd: 1.0 }, deps);

    expect(result.kind).toBe('replied');
  });

  it('skips cost check when costCapUsd is 0', async () => {
    const postReply = vi.fn().mockResolvedValue(undefined);
    const vcs = createFakeVCS({ postReply });
    const provider = makeProvider();
    const incrementTurn = makeIncrementTurn(1);
    const readTotals = vi.fn().mockResolvedValue({ running: 999, daily: 0 });
    const deps: ConversationRunnerDeps = { vcs, provider, incrementTurn, readTotals };

    const result = await handleConversationReply({ ...baseInput, costCapUsd: 0 }, deps);

    // costCapUsd = 0 → cost check skipped → proceeds
    expect(result.kind).toBe('replied');
    expect(readTotals).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Capability guard (CodeCommit)
// ---------------------------------------------------------------------------

describe('handleConversationReply — capability guard (#149)', () => {
  it('returns capability_unsupported when vcs does not support conversationReply', async () => {
    const vcs = createFakeVCS({
      capabilities: {
        clone: false,
        stateComment: 'postgres-only',
        approvalEvent: 'codecommit',
        commitMessages: false,
        conversationReply: false,
      },
    });
    const provider = makeProvider();
    const incrementTurn = makeIncrementTurn(1);
    const deps: ConversationRunnerDeps = { vcs, provider, incrementTurn };

    const result = await handleConversationReply(baseInput, deps);

    expect(result.kind).toBe('capability_unsupported');
    expect(provider.generateReview).not.toHaveBeenCalled();
  });
});
