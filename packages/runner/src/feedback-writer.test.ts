import type { FeedbackEvent } from '@review-agent/core';
import { describe, expect, it, vi } from 'vitest';
import { createFeedbackWriter, type ReviewHistoryWriter } from './feedback-writer.js';

function makeEvent(overrides: Partial<FeedbackEvent> = {}): FeedbackEvent {
  return {
    installationId: 42n,
    repo: 'almondoo/review-agent',
    prNumber: 7,
    fingerprint: 'abc123',
    kind: 'thumbs_down',
    factText: 'this is a false positive',
    occurredAt: new Date('2026-05-18T12:00:00Z'),
    ...overrides,
  };
}

describe('createFeedbackWriter', () => {
  it('maps thumbs_down to factType rejected_finding and inserts via writer', async () => {
    const writer: ReviewHistoryWriter = vi.fn(async () => undefined);
    const fb = createFeedbackWriter({ writer });
    const r = await fb.record(makeEvent());
    expect(r.dropped).toBe(false);
    expect(writer).toHaveBeenCalledTimes(1);
    const row = (writer as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(row?.factType).toBe('rejected_finding');
    expect(row?.installationId).toBe(42n);
    expect(row?.repo).toBe('almondoo/review-agent');
    // factText is prefixed with the fingerprint so Phase 4's reader
    // can route by comment id without re-deriving the link.
    expect(row?.factText.startsWith('[fp:abc123]')).toBe(true);
  });

  it('maps thumbs_up to factType accepted_pattern', async () => {
    const writer: ReviewHistoryWriter = vi.fn(async () => undefined);
    const fb = createFeedbackWriter({ writer });
    await fb.record(makeEvent({ kind: 'thumbs_up', factText: 'nice catch' }));
    const row = (writer as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(row?.factType).toBe('accepted_pattern');
  });

  it('maps dismissed to factType rejected_finding', async () => {
    const writer: ReviewHistoryWriter = vi.fn(async () => undefined);
    const fb = createFeedbackWriter({ writer });
    await fb.record(makeEvent({ kind: 'dismissed' }));
    const row = (writer as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(row?.factType).toBe('rejected_finding');
  });

  it('redacts a built-in secret (AWS access key) from factText before insert', async () => {
    const writer: ReviewHistoryWriter = vi.fn(async () => undefined);
    const fb = createFeedbackWriter({ writer });
    await fb.record(
      makeEvent({
        factText: 'this is leaking AKIAIOSFODNN7EXAMPLE in the comment body',
      }),
    );
    const row = (writer as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(row?.factText).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(row?.factText).toContain('[REDACTED:');
  });

  it('applies operator-supplied redact_patterns alongside built-ins', async () => {
    const writer: ReviewHistoryWriter = vi.fn(async () => undefined);
    const fb = createFeedbackWriter({
      writer,
      redactPatterns: ['ACME-[A-Z0-9]{8}'],
    });
    await fb.record(makeEvent({ factText: 'org token ACME-ABCD1234 leaked' }));
    const row = (writer as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(row?.factText).not.toContain('ACME-ABCD1234');
    expect(row?.factText).toContain('[REDACTED:');
  });

  it('silently drops invalid redact_patterns (matches runtime behavior)', async () => {
    const writer: ReviewHistoryWriter = vi.fn(async () => undefined);
    // `[invalid` is not a compilable JS regex; the writer must not
    // throw and should fall back to built-in scanning only.
    const fb = createFeedbackWriter({
      writer,
      redactPatterns: ['[invalid', 'ACME-[A-Z0-9]{4}'],
    });
    await fb.record(makeEvent({ factText: 'token ACME-AB12 leaked' }));
    const row = (writer as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(row?.factText).not.toContain('ACME-AB12');
  });

  it('enforces the 10-writes-per-job rate limit by default', async () => {
    const writer: ReviewHistoryWriter = vi.fn(async () => undefined);
    const onRateLimit = vi.fn();
    const fb = createFeedbackWriter({ writer, onRateLimit });
    for (let i = 0; i < 10; i += 1) {
      const r = await fb.record(makeEvent({ fingerprint: `fp-${i}` }));
      expect(r.dropped).toBe(false);
    }
    const overflow = await fb.record(makeEvent({ fingerprint: 'fp-11' }));
    expect(overflow.dropped).toBe(true);
    expect(writer).toHaveBeenCalledTimes(10);
    expect(onRateLimit).toHaveBeenCalledTimes(1);
  });

  it('honors a custom maxWritesPerJob', async () => {
    const writer: ReviewHistoryWriter = vi.fn(async () => undefined);
    const fb = createFeedbackWriter({ writer, maxWritesPerJob: 2 });
    await fb.record(makeEvent({ fingerprint: 'a' }));
    await fb.record(makeEvent({ fingerprint: 'b' }));
    const r = await fb.record(makeEvent({ fingerprint: 'c' }));
    expect(r.dropped).toBe(true);
    expect(writer).toHaveBeenCalledTimes(2);
  });

  it("does not rate-limit when maxWritesPerJob: 'unlimited' (backfill path)", async () => {
    // v1.2 follow-on #99: the backfill CLI ingests months of historical
    // reactions in one job and must opt out of the default 10/job cap.
    // The sentinel `'unlimited'` distinguishes this case at the type
    // level so a typo'd number can never silently disable the cap.
    const writer: ReviewHistoryWriter = vi.fn(async () => undefined);
    const onRateLimit = vi.fn();
    const fb = createFeedbackWriter({ writer, maxWritesPerJob: 'unlimited', onRateLimit });
    for (let i = 0; i < 25; i += 1) {
      const r = await fb.record(makeEvent({ fingerprint: `fp-${i}` }));
      expect(r.dropped).toBe(false);
    }
    expect(writer).toHaveBeenCalledTimes(25);
    expect(onRateLimit).not.toHaveBeenCalled();
  });
});
