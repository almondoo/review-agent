import { describe, expect, it } from 'vitest';
import { costQuerySchema, resolveSince, reviewsQuerySchema } from '../schemas.js';

describe('resolveSince', () => {
  const NOW = new Date('2026-05-01T12:00:00Z');

  it('resolves 24h alias to 24 hours ago', () => {
    const result = resolveSince('24h', NOW);
    expect(result.getTime()).toBe(NOW.getTime() - 24 * 60 * 60 * 1000);
  });

  it('resolves 7d alias to 7 days ago', () => {
    const result = resolveSince('7d', NOW);
    expect(result.getTime()).toBe(NOW.getTime() - 7 * 24 * 60 * 60 * 1000);
  });

  it('resolves 30d alias to 30 days ago', () => {
    const result = resolveSince('30d', NOW);
    expect(result.getTime()).toBe(NOW.getTime() - 30 * 24 * 60 * 60 * 1000);
  });

  it('parses ISO datetime string', () => {
    const iso = '2026-01-15T08:00:00Z';
    const result = resolveSince(iso, NOW);
    expect(result.toISOString()).toBe(new Date(iso).toISOString());
  });
});

describe('reviewsQuerySchema', () => {
  it('defaults limit to 50', () => {
    const parsed = reviewsQuerySchema.safeParse({});
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.limit).toBe(50);
  });

  it('clamps limit to 200', () => {
    const parsed = reviewsQuerySchema.safeParse({ limit: '999' });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.limit).toBe(200);
  });

  it('uses minimum limit of 1 for invalid low value (defaults to 50)', () => {
    const parsed = reviewsQuerySchema.safeParse({ limit: '0' });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.limit).toBe(50);
  });

  it('accepts valid platform values', () => {
    for (const p of ['github', 'codecommit']) {
      const parsed = reviewsQuerySchema.safeParse({ platform: p });
      expect(parsed.success).toBe(true);
    }
  });

  it('rejects invalid platform values', () => {
    const parsed = reviewsQuerySchema.safeParse({ platform: 'gitlab' });
    expect(parsed.success).toBe(false);
  });

  it('accepts valid outcome values', () => {
    for (const o of ['approved', 'changes_requested', 'commented', 'failed']) {
      const parsed = reviewsQuerySchema.safeParse({ outcome: o });
      expect(parsed.success).toBe(true);
    }
  });

  it('rejects invalid outcome values', () => {
    const parsed = reviewsQuerySchema.safeParse({ outcome: 'merged' });
    expect(parsed.success).toBe(false);
  });

  it('accepts since aliases', () => {
    for (const s of ['24h', '7d', '30d']) {
      const parsed = reviewsQuerySchema.safeParse({ since: s });
      expect(parsed.success).toBe(true);
    }
  });

  it('rejects invalid since value', () => {
    const parsed = reviewsQuerySchema.safeParse({ since: 'yesterday' });
    expect(parsed.success).toBe(false);
  });

  it('accepts ISO datetime string for since', () => {
    const parsed = reviewsQuerySchema.safeParse({ since: '2026-01-01T00:00:00Z' });
    expect(parsed.success).toBe(true);
  });
});

describe('costQuerySchema', () => {
  it('defaults since to 30d and limit to 20 when omitted', () => {
    const parsed = costQuerySchema.safeParse({});
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.since).toBe('30d');
    expect(parsed.data.limit).toBe(20);
    expect(parsed.data.cursor).toBeUndefined();
  });

  it('accepts all valid since aliases', () => {
    for (const since of ['24h', '7d', '30d']) {
      const parsed = costQuerySchema.safeParse({ since });
      expect(parsed.success).toBe(true);
    }
  });

  it('rejects invalid since value', () => {
    const parsed = costQuerySchema.safeParse({ since: 'yesterday' });
    expect(parsed.success).toBe(false);
  });

  it('clamps limit to 200 max', () => {
    const parsed = costQuerySchema.safeParse({ limit: '500' });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.limit).toBe(200);
  });

  it('defaults to 20 for non-finite limit string', () => {
    const parsed = costQuerySchema.safeParse({ limit: 'abc' });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.limit).toBe(20);
  });

  it('defaults to 20 for limit below 1', () => {
    const parsed = costQuerySchema.safeParse({ limit: '0' });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.limit).toBe(20);
  });

  it('passes cursor through', () => {
    const parsed = costQuerySchema.safeParse({ cursor: 'owner/repo-5' });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.cursor).toBe('owner/repo-5');
  });
});
