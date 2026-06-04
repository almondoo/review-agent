/**
 * Tests for the #155 suppression-threshold path in createFeedbackWriter.
 */
import type { FeedbackEvent } from '@review-agent/core';
import { describe, expect, it, vi } from 'vitest';
import {
  createFeedbackWriter,
  type ReviewHistoryWriter,
  type SuppressionOpts,
} from '../feedback-writer.js';

function makeEvent(overrides: Partial<FeedbackEvent> = {}): FeedbackEvent {
  return {
    installationId: 1n,
    repo: 'org/repo',
    prNumber: 1,
    fingerprint: 'abc123',
    kind: 'thumbs_down',
    factText: 'false positive on line 5',
    occurredAt: new Date('2026-06-01T00:00:00Z'),
    ...overrides,
  };
}

function makeSuppressionOpts(overrides: Partial<SuppressionOpts> = {}): SuppressionOpts {
  return {
    suppressAfter: 3,
    rejectionCounter: vi.fn().mockResolvedValue(0),
    suppressionLoader: vi.fn().mockResolvedValue([]),
    suppressionWriter: vi.fn().mockResolvedValue(undefined),
    onSuppressionRuleCreated: vi.fn(),
    ...overrides,
  };
}

describe('createFeedbackWriter — suppression path (#155)', () => {
  it('does NOT create a suppression rule when rejection count is below threshold', async () => {
    const writer: ReviewHistoryWriter = vi.fn(async () => undefined);
    const so = makeSuppressionOpts({
      suppressAfter: 3,
      rejectionCounter: vi.fn().mockResolvedValue(2), // below threshold
    });
    const fb = createFeedbackWriter({ writer, suppressionOpts: so });
    await fb.record(makeEvent());

    expect(so.suppressionWriter).not.toHaveBeenCalled();
    expect(so.onSuppressionRuleCreated).not.toHaveBeenCalled();
  });

  it('creates a suppression rule when rejection count reaches threshold', async () => {
    const writer: ReviewHistoryWriter = vi.fn(async () => undefined);
    const so = makeSuppressionOpts({
      suppressAfter: 3,
      rejectionCounter: vi.fn().mockResolvedValue(3), // at threshold
    });
    const fb = createFeedbackWriter({ writer, suppressionOpts: so });
    await fb.record(makeEvent({ fingerprint: 'fp1' }));

    expect(so.suppressionWriter).toHaveBeenCalledOnce();
    const call = (so.suppressionWriter as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(call?.fingerprint).toBe('fp1');
    expect(call?.repo).toBe('org/repo');
    expect(so.onSuppressionRuleCreated).toHaveBeenCalledWith('org/repo');
  });

  it('creates a suppression rule when rejection count exceeds threshold', async () => {
    const writer: ReviewHistoryWriter = vi.fn(async () => undefined);
    const so = makeSuppressionOpts({
      suppressAfter: 3,
      rejectionCounter: vi.fn().mockResolvedValue(5), // above threshold
    });
    const fb = createFeedbackWriter({ writer, suppressionOpts: so });
    await fb.record(makeEvent({ fingerprint: 'fp2' }));

    expect(so.suppressionWriter).toHaveBeenCalledOnce();
  });

  it('does NOT create a duplicate suppression rule when one already exists', async () => {
    const writer: ReviewHistoryWriter = vi.fn(async () => undefined);
    const so = makeSuppressionOpts({
      suppressAfter: 3,
      rejectionCounter: vi.fn().mockResolvedValue(4),
      suppressionLoader: vi.fn().mockResolvedValue([{ factText: '[fp:fp3] already suppressed' }]),
    });
    const fb = createFeedbackWriter({ writer, suppressionOpts: so });
    await fb.record(makeEvent({ fingerprint: 'fp3' }));

    // The loader returned an existing rule → no new rule.
    expect(so.suppressionWriter).not.toHaveBeenCalled();
  });

  it('does NOT run suppression check for thumbs_up events', async () => {
    const writer: ReviewHistoryWriter = vi.fn(async () => undefined);
    const so = makeSuppressionOpts({
      suppressAfter: 1,
      rejectionCounter: vi.fn().mockResolvedValue(5),
    });
    const fb = createFeedbackWriter({ writer, suppressionOpts: so });
    await fb.record(makeEvent({ kind: 'thumbs_up' }));

    expect(so.rejectionCounter).not.toHaveBeenCalled();
    expect(so.suppressionWriter).not.toHaveBeenCalled();
  });

  it('swallows errors from the threshold checker (fail-open)', async () => {
    const writer: ReviewHistoryWriter = vi.fn(async () => undefined);
    const so = makeSuppressionOpts({
      suppressAfter: 3,
      rejectionCounter: vi.fn().mockRejectedValue(new Error('DB down')),
    });
    const fb = createFeedbackWriter({ writer, suppressionOpts: so });
    // Must not throw — the primary record() call must still succeed.
    const result = await fb.record(makeEvent());
    expect(result.dropped).toBe(false);
    expect(writer).toHaveBeenCalledOnce();
  });

  it('swallows errors from the suppressionWriter (fail-open)', async () => {
    const writer: ReviewHistoryWriter = vi.fn(async () => undefined);
    const so = makeSuppressionOpts({
      suppressAfter: 1,
      rejectionCounter: vi.fn().mockResolvedValue(2),
      suppressionWriter: vi.fn().mockRejectedValue(new Error('write failed')),
    });
    const fb = createFeedbackWriter({ writer, suppressionOpts: so });
    const result = await fb.record(makeEvent());
    expect(result.dropped).toBe(false);
    expect(writer).toHaveBeenCalledOnce();
  });

  it('does nothing when suppressionOpts is absent', async () => {
    const writer: ReviewHistoryWriter = vi.fn(async () => undefined);
    // No suppressionOpts → existing behavior unchanged.
    const fb = createFeedbackWriter({ writer });
    const result = await fb.record(makeEvent());
    expect(result.dropped).toBe(false);
    expect(writer).toHaveBeenCalledOnce();
  });

  it('passes the fingerprint from the factText prefix to the rejection counter', async () => {
    const writer: ReviewHistoryWriter = vi.fn(async () => undefined);
    const rejectionCounter = vi.fn().mockResolvedValue(0);
    const so = makeSuppressionOpts({ suppressAfter: 3, rejectionCounter });
    const fb = createFeedbackWriter({ writer, suppressionOpts: so });
    await fb.record(makeEvent({ fingerprint: 'deadbeef01' }));

    expect(rejectionCounter).toHaveBeenCalledWith(
      expect.objectContaining({ fingerprint: 'deadbeef01' }),
    );
  });
});
