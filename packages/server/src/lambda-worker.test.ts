import { CostExceededError } from '@review-agent/core';
import { describe, expect, it, vi } from 'vitest';
import type { LambdaFailureDeps } from './lambda-worker.js';
import { createSqsLambdaHandler } from './lambda-worker.js';

const goodBody = JSON.stringify({
  jobId: 'j',
  installationId: '11',
  prRef: { platform: 'github', owner: 'o', repo: 'r', number: 1 },
  triggeredBy: 'pull_request.opened',
  enqueuedAt: '2026-04-30T00:00:00.000Z',
});

function makeFailureDeps(overrides: Partial<LambdaFailureDeps> = {}): LambdaFailureDeps {
  return {
    notifier: { dispatch: vi.fn().mockResolvedValue(undefined) },
    vcs: {
      platform: 'github',
      capabilities: {
        clone: true,
        stateComment: 'native',
        approvalEvent: 'github',
        commitMessages: true,
        conversationReply: true,
        committableSuggestions: true,
      },
      getStateComment: vi.fn().mockResolvedValue(null),
      upsertStateComment: vi.fn().mockResolvedValue(undefined),
      getPR: vi.fn(),
      getDiff: vi.fn(),
      getFile: vi.fn(),
      cloneRepo: vi.fn(),
      getExistingComments: vi.fn(),
      postReview: vi.fn(),
      postSummary: vi.fn(),
      postReply: vi.fn(),
    } as unknown as LambdaFailureDeps['vcs'],
    logger: {
      error: vi.fn(),
      warn: vi.fn(),
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Existing tests (backward-compat)
// ---------------------------------------------------------------------------

describe('createSqsLambdaHandler', () => {
  it('processes valid records with no failures', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const fn = createSqsLambdaHandler({ handler });
    const r = await fn({
      Records: [{ messageId: 'a', body: goodBody, receiptHandle: 'h' }],
    });
    expect(r).toEqual({ batchItemFailures: [] });
    expect(handler).toHaveBeenCalledOnce();
  });

  it('reports a batch item failure on malformed body', async () => {
    const handler = vi.fn();
    const fn = createSqsLambdaHandler({ handler });
    const r = await fn({
      Records: [{ messageId: 'bad', body: '{not json', receiptHandle: 'h' }],
    });
    expect(r.batchItemFailures).toEqual([{ itemIdentifier: 'bad' }]);
    expect(handler).not.toHaveBeenCalled();
  });

  it('reports a batch item failure when handler throws (no failureDeps)', async () => {
    const handler = vi.fn().mockRejectedValue(new Error('boom'));
    const fn = createSqsLambdaHandler({ handler });
    const r = await fn({
      Records: [{ messageId: 'bz', body: goodBody, receiptHandle: 'h' }],
    });
    expect(r.batchItemFailures).toEqual([{ itemIdentifier: 'bz' }]);
  });
});

// ---------------------------------------------------------------------------
// Transient failure path (#138)
// ---------------------------------------------------------------------------

describe('createSqsLambdaHandler — transient failure path', () => {
  it('adds to batchItemFailures for transient errors (rate_limit)', async () => {
    const transientErr = Object.assign(new Error('rate limited'), { kind: 'rate_limit' });
    const handler = vi.fn().mockRejectedValue(transientErr);
    const failureDeps = makeFailureDeps();
    const fn = createSqsLambdaHandler({ handler, failureDeps });
    const r = await fn({
      Records: [{ messageId: 'tr-1', body: goodBody, receiptHandle: 'h' }],
    });
    expect(r.batchItemFailures).toEqual([{ itemIdentifier: 'tr-1' }]);
    // No notification or state comment for transient failures.
    expect(failureDeps.notifier.dispatch).not.toHaveBeenCalled();
    expect(failureDeps.vcs.upsertStateComment).not.toHaveBeenCalled();
  });

  it('adds to batchItemFailures for unknown errors (default transient)', async () => {
    const handler = vi.fn().mockRejectedValue(new Error('unknown'));
    const failureDeps = makeFailureDeps();
    const fn = createSqsLambdaHandler({ handler, failureDeps });
    const r = await fn({
      Records: [{ messageId: 'tr-2', body: goodBody, receiptHandle: 'h' }],
    });
    expect(r.batchItemFailures).toEqual([{ itemIdentifier: 'tr-2' }]);
    expect(failureDeps.notifier.dispatch).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Permanent failure path (#138)
// ---------------------------------------------------------------------------

describe('createSqsLambdaHandler — permanent failure path', () => {
  it('does NOT add to batchItemFailures for permanent errors', async () => {
    const permanentErr = new CostExceededError(1.0, 2.0);
    const handler = vi.fn().mockRejectedValue(permanentErr);
    const failureDeps = makeFailureDeps();
    const fn = createSqsLambdaHandler({ handler, failureDeps });
    const r = await fn({
      Records: [{ messageId: 'pm-1', body: goodBody, receiptHandle: 'h' }],
    });
    // Permanent failure: message is acked, NOT re-delivered.
    expect(r.batchItemFailures).toEqual([]);
  });

  it('dispatches job.failed notification for permanent errors', async () => {
    const permanentErr = new CostExceededError(1.0, 2.0);
    const handler = vi.fn().mockRejectedValue(permanentErr);
    const failureDeps = makeFailureDeps();
    const fn = createSqsLambdaHandler({ handler, failureDeps });
    await fn({ Records: [{ messageId: 'pm-2', body: goodBody, receiptHandle: 'h' }] });

    expect(failureDeps.notifier.dispatch).toHaveBeenCalledOnce();
    const event = (failureDeps.notifier.dispatch as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(event.type).toBe('job.failed');
    expect(event.jobId).toBe('j');
    expect(event.repo).toBe('o/r');
  });

  it('writes a FAILED state comment for permanent errors', async () => {
    const permanentErr = new CostExceededError(1.0, 2.0);
    const handler = vi.fn().mockRejectedValue(permanentErr);
    const failureDeps = makeFailureDeps();
    const fn = createSqsLambdaHandler({ handler, failureDeps });
    await fn({ Records: [{ messageId: 'pm-3', body: goodBody, receiptHandle: 'h' }] });

    expect(failureDeps.vcs.upsertStateComment).toHaveBeenCalledOnce();
    const [, state] = (failureDeps.vcs.upsertStateComment as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(state.modelUsed).toMatch(/^FAILED:/);
  });

  it('preserves existing state fields when state comment already exists', async () => {
    const existingState = {
      schemaVersion: 1 as const,
      lastReviewedSha: 'abc1234',
      baseSha: 'base123',
      reviewedAt: '2026-01-01T00:00:00.000Z',
      modelUsed: 'claude-3-5-sonnet',
      totalTokens: 9000,
      totalCostUsd: 0.03,
      commentFingerprints: ['fp-a'],
    };
    const permanentErr = new CostExceededError(1.0, 2.0);
    const handler = vi.fn().mockRejectedValue(permanentErr);
    const failureDeps = makeFailureDeps();
    (failureDeps.vcs.getStateComment as ReturnType<typeof vi.fn>).mockResolvedValue(existingState);
    const fn = createSqsLambdaHandler({ handler, failureDeps });
    await fn({ Records: [{ messageId: 'pm-4', body: goodBody, receiptHandle: 'h' }] });

    const [, state] = (failureDeps.vcs.upsertStateComment as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(state.lastReviewedSha).toBe('abc1234');
    expect(state.totalTokens).toBe(9000);
    expect(state.commentFingerprints).toEqual(['fp-a']);
    expect(state.modelUsed).toMatch(/^FAILED:/);
  });
});

// ---------------------------------------------------------------------------
// Permanent failure — fail-open side-effects (#138)
// ---------------------------------------------------------------------------

describe('createSqsLambdaHandler — permanent failure fail-open', () => {
  it('still acks message when notifier throws', async () => {
    const permanentErr = new CostExceededError(1.0, 2.0);
    const handler = vi.fn().mockRejectedValue(permanentErr);
    const failureDeps = makeFailureDeps();
    (failureDeps.notifier.dispatch as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('notifier down'),
    );
    const fn = createSqsLambdaHandler({ handler, failureDeps });
    const r = await fn({
      Records: [{ messageId: 'fo-1', body: goodBody, receiptHandle: 'h' }],
    });
    // Still acked (not in batchItemFailures) even though notifier threw.
    expect(r.batchItemFailures).toEqual([]);
  });

  it('still dispatches notification when state comment write fails', async () => {
    const permanentErr = new CostExceededError(1.0, 2.0);
    const handler = vi.fn().mockRejectedValue(permanentErr);
    const failureDeps = makeFailureDeps();
    (failureDeps.vcs.upsertStateComment as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('vcs down'),
    );
    const fn = createSqsLambdaHandler({ handler, failureDeps });
    await fn({ Records: [{ messageId: 'fo-2', body: goodBody, receiptHandle: 'h' }] });
    expect(failureDeps.notifier.dispatch).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// #16/#62 regression: idempotency and state-comment retry behaviour preserved
// ---------------------------------------------------------------------------

describe('createSqsLambdaHandler — #16 idempotency and #62 state-comment regression', () => {
  it('processes two records with the same jobId independently (no cross-contamination)', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const fn = createSqsLambdaHandler({ handler });
    const r = await fn({
      Records: [
        { messageId: 'idem-1', body: goodBody, receiptHandle: 'h1' },
        { messageId: 'idem-2', body: goodBody, receiptHandle: 'h2' },
      ],
    });
    // Both succeed — no failures.
    expect(r.batchItemFailures).toEqual([]);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('does not upsert state comment on success (only on permanent failure)', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const failureDeps = makeFailureDeps();
    const fn = createSqsLambdaHandler({ handler, failureDeps });
    await fn({ Records: [{ messageId: 'sc-1', body: goodBody, receiptHandle: 'h' }] });
    // No state comment on success path.
    expect(failureDeps.vcs.upsertStateComment).not.toHaveBeenCalled();
  });
});
