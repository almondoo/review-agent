import { describe, expect, it, vi } from 'vitest';
import { createReviewHistoryWriter } from './review-history.js';

function makeDb() {
  const insert = vi.fn(() => ({
    values: vi.fn().mockResolvedValue(undefined),
  }));
  return {
    db: { insert } as never,
    insert,
  };
}

describe('createReviewHistoryWriter', () => {
  it('inserts a row with the four required fields and lets the schema default expires_at', async () => {
    const { db, insert } = makeDb();
    const writer = createReviewHistoryWriter(db);
    await writer({
      installationId: 42n,
      repo: 'almondoo/review-agent',
      factType: 'rejected_finding',
      factText: '[fp:abc123] dismissed by alice',
    });
    expect(insert).toHaveBeenCalledTimes(1);
    const valuesCall = (insert.mock.results[0]?.value as { values: ReturnType<typeof vi.fn> })
      ?.values;
    const row = valuesCall.mock.calls[0]?.[0];
    expect(row).toEqual({
      installationId: 42n,
      repo: 'almondoo/review-agent',
      factType: 'rejected_finding',
      factText: '[fp:abc123] dismissed by alice',
    });
    // The writer must NOT pass an explicit expires_at — Drizzle's
    // schema default (`now() + interval '180 days'`) is the source
    // of truth, and a wrong client clock should not be able to
    // shorten / extend the TTL on insert.
    expect(row).not.toHaveProperty('expiresAt');
    expect(row).not.toHaveProperty('createdAt');
  });

  it('passes factType verbatim across the three allowed discriminator values', async () => {
    const { db, insert } = makeDb();
    const writer = createReviewHistoryWriter(db);
    for (const factType of ['accepted_pattern', 'rejected_finding', 'arch_decision'] as const) {
      await writer({
        installationId: 1n,
        repo: 'o/r',
        factType,
        factText: 'x',
      });
    }
    expect(insert).toHaveBeenCalledTimes(3);
    const types = insert.mock.results
      .map((r) => (r.value as { values: ReturnType<typeof vi.fn> }).values.mock.calls[0]?.[0])
      .map((row) => row?.factType);
    expect(types).toEqual(['accepted_pattern', 'rejected_finding', 'arch_decision']);
  });
});
