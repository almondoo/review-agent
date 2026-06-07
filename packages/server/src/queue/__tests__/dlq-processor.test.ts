import { describe, expect, it, vi } from 'vitest';
import type { DlqProcessorDeps } from '../dlq-processor.js';
import { createDlqLambdaHandler } from '../dlq-processor.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const baseMsg = {
  jobId: 'j-1',
  installationId: '42',
  prRef: { platform: 'github' as const, owner: 'acme', repo: 'api', number: 7 },
  triggeredBy: 'pull_request.opened' as const,
  enqueuedAt: '2026-04-30T00:00:00.000Z',
};

const goodBody = JSON.stringify(baseMsg);

function makeDeps(overrides: Partial<DlqProcessorDeps> = {}): DlqProcessorDeps {
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
      // Unused write surfaces — satisfy the VCS interface minimally
      getPR: vi.fn(),
      getDiff: vi.fn(),
      getFile: vi.fn(),
      cloneRepo: vi.fn(),
      getExistingComments: vi.fn(),
      postReview: vi.fn(),
      postSummary: vi.fn(),
      postReply: vi.fn(),
    } as unknown as DlqProcessorDeps['vcs'],
    logger: {
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
    },
    now: () => new Date('2026-06-04T12:00:00.000Z'),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Parse failure
// ---------------------------------------------------------------------------

describe('createDlqLambdaHandler — parse failure', () => {
  it('returns batchItemFailures for malformed body', async () => {
    const deps = makeDeps();
    const handler = createDlqLambdaHandler(deps);
    const result = await handler({
      Records: [{ messageId: 'bad-1', body: '{not json' }],
    });
    expect(result.batchItemFailures).toEqual([{ itemIdentifier: 'bad-1' }]);
    expect(deps.notifier.dispatch).not.toHaveBeenCalled();
    expect(deps.vcs.upsertStateComment).not.toHaveBeenCalled();
  });

  it('returns batchItemFailures for schema-invalid body (not a JobMessage)', async () => {
    const deps = makeDeps();
    const handler = createDlqLambdaHandler(deps);
    const result = await handler({
      Records: [{ messageId: 'bad-2', body: JSON.stringify({ irrelevant: true }) }],
    });
    expect(result.batchItemFailures).toEqual([{ itemIdentifier: 'bad-2' }]);
  });

  it('processes valid records even when a preceding record fails to parse', async () => {
    const deps = makeDeps();
    const handler = createDlqLambdaHandler(deps);
    const result = await handler({
      Records: [
        { messageId: 'bad-3', body: 'not json' },
        { messageId: 'good-1', body: goodBody },
      ],
    });
    expect(result.batchItemFailures).toEqual([{ itemIdentifier: 'bad-3' }]);
    // The valid record must have been processed.
    expect(deps.vcs.upsertStateComment).toHaveBeenCalledOnce();
    expect(deps.notifier.dispatch).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// Happy path — state comment + notification
// ---------------------------------------------------------------------------

describe('createDlqLambdaHandler — state comment + notification dispatch', () => {
  it('upserts a FAILED state comment with the correct shape', async () => {
    const deps = makeDeps();
    const handler = createDlqLambdaHandler(deps);
    await handler({ Records: [{ messageId: 'ok-1', body: goodBody }] });

    expect(deps.vcs.upsertStateComment).toHaveBeenCalledOnce();
    const [ref, state] = (deps.vcs.upsertStateComment as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(ref).toMatchObject({ owner: 'acme', repo: 'api', number: 7 });
    expect(state.modelUsed).toMatch(/^FAILED \(DLQ\):/);
    expect(state.reviewedAt).toBe('2026-06-04T12:00:00.000Z');
  });

  it('dispatches a job.failed notification with the correct event shape', async () => {
    const deps = makeDeps();
    const handler = createDlqLambdaHandler(deps);
    await handler({ Records: [{ messageId: 'ok-2', body: goodBody }] });

    expect(deps.notifier.dispatch).toHaveBeenCalledOnce();
    const event = (deps.notifier.dispatch as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(event.type).toBe('job.failed');
    expect(event.jobId).toBe('j-1');
    expect(event.repo).toBe('acme/api');
    expect(event.installationId).toBe('42');
    expect(event.prNumber).toBe(7);
    expect(event.summary).toContain('DLQ');
  });

  it('synthesises a ReviewState when no existing state comment is present', async () => {
    const deps = makeDeps();
    (deps.vcs.getStateComment as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const handler = createDlqLambdaHandler(deps);
    await handler({ Records: [{ messageId: 'ok-3', body: goodBody }] });

    const [, state] = (deps.vcs.upsertStateComment as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(state.schemaVersion).toBe(1);
    expect(state.totalTokens).toBe(0);
    expect(state.commentFingerprints).toEqual([]);
  });

  it('preserves existing state fields when a state comment already exists', async () => {
    const existingState = {
      schemaVersion: 1 as const,
      lastReviewedSha: 'abc1234',
      baseSha: 'base123',
      reviewedAt: '2026-01-01T00:00:00.000Z',
      modelUsed: 'claude-3-5-sonnet',
      totalTokens: 5000,
      totalCostUsd: 0.02,
      commentFingerprints: ['fp1', 'fp2'],
    };
    const deps = makeDeps();
    (deps.vcs.getStateComment as ReturnType<typeof vi.fn>).mockResolvedValue(existingState);
    const handler = createDlqLambdaHandler(deps);
    await handler({ Records: [{ messageId: 'ok-4', body: goodBody }] });

    const [, state] = (deps.vcs.upsertStateComment as ReturnType<typeof vi.fn>).mock.calls[0];
    // Existing fields preserved.
    expect(state.lastReviewedSha).toBe('abc1234');
    expect(state.totalTokens).toBe(5000);
    expect(state.commentFingerprints).toEqual(['fp1', 'fp2']);
    // Only reviewedAt and modelUsed updated.
    expect(state.modelUsed).toMatch(/^FAILED \(DLQ\):/);
    expect(state.reviewedAt).toBe('2026-06-04T12:00:00.000Z');
  });

  it('returns empty batchItemFailures on a fully successful batch', async () => {
    const deps = makeDeps();
    const handler = createDlqLambdaHandler(deps);
    const result = await handler({ Records: [{ messageId: 'ok-5', body: goodBody }] });
    expect(result.batchItemFailures).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Fail-open behaviour
// ---------------------------------------------------------------------------

describe('createDlqLambdaHandler — fail-open side-effects', () => {
  it('continues without throwing when notifier.dispatch rejects', async () => {
    const deps = makeDeps();
    (deps.notifier.dispatch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('slack down'));
    const handler = createDlqLambdaHandler(deps);
    // Must not throw.
    const result = await handler({ Records: [{ messageId: 'fo-1', body: goodBody }] });
    expect(result.batchItemFailures).toEqual([]);
    // State comment was still attempted.
    expect(deps.vcs.upsertStateComment).toHaveBeenCalledOnce();
  });

  it('continues without throwing when vcs.getStateComment rejects', async () => {
    const deps = makeDeps();
    (deps.vcs.getStateComment as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('vcs down'));
    const handler = createDlqLambdaHandler(deps);
    const result = await handler({ Records: [{ messageId: 'fo-2', body: goodBody }] });
    // upsertStateComment is not called if getStateComment threw.
    expect(result.batchItemFailures).toEqual([]);
    // Notification must still have been attempted.
    expect(deps.notifier.dispatch).toHaveBeenCalledOnce();
  });

  it('continues without throwing when vcs.upsertStateComment rejects', async () => {
    const deps = makeDeps();
    (deps.vcs.upsertStateComment as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('comment API down'),
    );
    const handler = createDlqLambdaHandler(deps);
    const result = await handler({ Records: [{ messageId: 'fo-3', body: goodBody }] });
    expect(result.batchItemFailures).toEqual([]);
    expect(deps.notifier.dispatch).toHaveBeenCalledOnce();
  });
});
