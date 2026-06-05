import { describe, expect, it, vi } from 'vitest';
import { createReviewEvalEventRecorder } from './review-eval-event.js';

function makeDb() {
  const insert = vi.fn(() => ({
    values: vi.fn().mockResolvedValue(undefined),
  }));
  return {
    db: { insert } as never,
    insert,
  };
}

describe('createReviewEvalEventRecorder', () => {
  it('inserts a row carrying every ReviewEvalEvent column', async () => {
    const { db, insert } = makeDb();
    const recorder = createReviewEvalEventRecorder(db);
    await recorder({
      installationId: 42n,
      jobId: 'job-1',
      repo: 'owner/repo',
      prNumber: 7,
      headSha: 'deadbeef',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      commentCount: 3,
      severityDist: { critical: 1, major: 1, minor: 1, info: 0 },
      confidenceDist: { high: 2, medium: 1, low: 0 },
      droppedDuplicates: 4,
      droppedByFeedback: 2,
      toolCalls: 9,
      latencyMs: 1234,
      costUsd: 0.0567,
      tokensInput: 1000,
      tokensOutput: 250,
      abortReason: null,
    });
    expect(insert).toHaveBeenCalledTimes(1);
    const valuesCall = (insert.mock.results[0]?.value as { values: ReturnType<typeof vi.fn> })
      ?.values;
    expect(valuesCall).toHaveBeenCalledTimes(1);
    const row = valuesCall.mock.calls[0]?.[0];
    expect(row).toMatchObject({
      installationId: 42n,
      jobId: 'job-1',
      repo: 'owner/repo',
      prNumber: 7,
      headSha: 'deadbeef',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      commentCount: 3,
      severityDist: { critical: 1, major: 1, minor: 1, info: 0 },
      confidenceDist: { high: 2, medium: 1, low: 0 },
      droppedDuplicates: 4,
      droppedByFeedback: 2,
      toolCalls: 9,
      latencyMs: 1234,
      costUsd: 0.0567,
      tokensInput: 1000,
      tokensOutput: 250,
      abortReason: null,
    });
    // filesTotal/filesReviewed not in event → not in row
    expect(row?.filesTotal).toBeUndefined();
    expect(row?.filesReviewed).toBeUndefined();
  });

  it('forwards filesTotal and filesReviewed when present in event', async () => {
    const { db, insert } = makeDb();
    const recorder = createReviewEvalEventRecorder(db);
    await recorder({
      installationId: 1n,
      jobId: 'j',
      repo: 'o/r',
      prNumber: 1,
      headSha: 'h',
      provider: 'anthropic',
      model: 'm',
      commentCount: 0,
      severityDist: { critical: 0, major: 0, minor: 0, info: 0 },
      confidenceDist: { high: 0, medium: 0, low: 0 },
      droppedDuplicates: 0,
      droppedByFeedback: 0,
      toolCalls: 0,
      latencyMs: 5,
      costUsd: 0,
      tokensInput: 0,
      tokensOutput: 0,
      abortReason: null,
      filesTotal: 20,
      filesReviewed: 15,
    });
    const valuesCall = (insert.mock.results[0]?.value as { values: ReturnType<typeof vi.fn> })
      ?.values;
    const row = valuesCall.mock.calls[0]?.[0];
    expect(row?.filesTotal).toBe(20);
    expect(row?.filesReviewed).toBe(15);
  });

  it('omits filesTotal/filesReviewed from row when event has null values', async () => {
    const { db, insert } = makeDb();
    const recorder = createReviewEvalEventRecorder(db);
    await recorder({
      installationId: 1n,
      jobId: 'j',
      repo: 'o/r',
      prNumber: 1,
      headSha: 'h',
      provider: 'anthropic',
      model: 'm',
      commentCount: 0,
      severityDist: { critical: 0, major: 0, minor: 0, info: 0 },
      confidenceDist: { high: 0, medium: 0, low: 0 },
      droppedDuplicates: 0,
      droppedByFeedback: 0,
      toolCalls: 0,
      latencyMs: 5,
      costUsd: 0,
      tokensInput: 0,
      tokensOutput: 0,
      abortReason: null,
      filesTotal: null,
      filesReviewed: null,
    });
    const valuesCall = (insert.mock.results[0]?.value as { values: ReturnType<typeof vi.fn> })
      ?.values;
    const row = valuesCall.mock.calls[0]?.[0];
    expect(row?.filesTotal).toBeUndefined();
    expect(row?.filesReviewed).toBeUndefined();
  });

  it('forwards a non-null abortReason verbatim (graceful cap-skip / schema retry abort)', async () => {
    const { db, insert } = makeDb();
    const recorder = createReviewEvalEventRecorder(db);
    await recorder({
      installationId: 1n,
      jobId: 'j',
      repo: 'o/r',
      prNumber: 1,
      headSha: 'h',
      provider: 'anthropic',
      model: 'm',
      commentCount: 0,
      severityDist: { critical: 0, major: 0, minor: 0, info: 0 },
      confidenceDist: { high: 0, medium: 0, low: 0 },
      droppedDuplicates: 0,
      droppedByFeedback: 0,
      toolCalls: 0,
      latencyMs: 5,
      costUsd: 0,
      tokensInput: 0,
      tokensOutput: 0,
      abortReason: 'max_diff_lines_exceeded',
    });
    const valuesCall = (insert.mock.results[0]?.value as { values: ReturnType<typeof vi.fn> })
      ?.values;
    const row = valuesCall.mock.calls[0]?.[0];
    expect(row?.abortReason).toBe('max_diff_lines_exceeded');
  });
});
