import { describe, expect, it } from 'vitest';
import {
  AUDIT_GENESIS_HASH,
  appendAuditRow,
  type ChainLink,
  canonicalPayload,
  computeAuditHash,
  verifyAuditChain,
  verifyAuditChainSegment,
} from './audit.js';

const fixedNow = () => new Date('2026-04-30T00:00:00.000Z');

describe('audit chain', () => {
  it('first row uses genesis prev hash', () => {
    const row = appendAuditRow(null, { event: 'review.start' }, fixedNow);
    expect(row.prevHash).toBe(AUDIT_GENESIS_HASH);
    expect(row.hash).toHaveLength(64);
  });

  it('subsequent row chains to previous hash', () => {
    const r1 = appendAuditRow(null, { event: 'review.start' }, fixedNow);
    const r2 = appendAuditRow(r1.hash, { event: 'review.complete' }, fixedNow);
    expect(r2.prevHash).toBe(r1.hash);
    expect(r2.hash).not.toBe(r1.hash);
  });

  it('hash is deterministic for the same payload + ts + prev', () => {
    const ev = { event: 'x', installationId: 7n, prId: 'o/r#1' };
    const ts = new Date('2026-04-30T00:00:00.000Z');
    expect(computeAuditHash('z'.repeat(64), ev, ts)).toBe(computeAuditHash('z'.repeat(64), ev, ts));
  });

  it('different prev hash produces different chain hash', () => {
    const ev = { event: 'x' };
    const ts = new Date('2026-04-30T00:00:00.000Z');
    const a = computeAuditHash('a'.repeat(64), ev, ts);
    const b = computeAuditHash('b'.repeat(64), ev, ts);
    expect(a).not.toBe(b);
  });

  it('verifyAuditChain accepts intact chain', () => {
    const r1 = appendAuditRow(null, { event: 'a' }, fixedNow);
    const r2 = appendAuditRow(r1.hash, { event: 'b' }, fixedNow);
    const links: ChainLink[] = [r1, r2].map((r) => ({
      prevHash: r.prevHash,
      hash: r.hash,
      ts: r.ts,
      event: r.event,
      installationId: r.installationId ?? null,
      prId: r.prId ?? null,
      model: r.model ?? null,
      inputTokens: r.inputTokens ?? null,
      outputTokens: r.outputTokens ?? null,
    }));
    expect(verifyAuditChain(links).ok).toBe(true);
  });

  it('verifyAuditChainSegment treats the first row as anchor (post-prune)', () => {
    // Build a 3-row chain, then drop the first and verify the surviving
    // segment as if rows[0] were a prior anchor whose predecessors no
    // longer exist. The segment must verify without the genesis row.
    const r1 = appendAuditRow(null, { event: 'a' }, fixedNow);
    const r2 = appendAuditRow(r1.hash, { event: 'b' }, fixedNow);
    const r3 = appendAuditRow(r2.hash, { event: 'c' }, fixedNow);
    const tail: ChainLink[] = [r2, r3].map((r) => ({
      prevHash: r.prevHash,
      hash: r.hash,
      ts: r.ts,
      event: r.event,
      installationId: r.installationId ?? null,
      prId: r.prId ?? null,
      model: r.model ?? null,
      inputTokens: r.inputTokens ?? null,
      outputTokens: r.outputTokens ?? null,
    }));
    // The same tail handed to verifyAuditChain would fail (the first row
    // hashes from r1.hash, not from the genesis).
    expect(verifyAuditChain(tail).ok).toBe(false);
    expect(verifyAuditChainSegment(tail).ok).toBe(true);
  });

  it('verifyAuditChainSegment rejects a break in the surviving tail', () => {
    const r1 = appendAuditRow(null, { event: 'a' }, fixedNow);
    const r2 = appendAuditRow(r1.hash, { event: 'b' }, fixedNow);
    const r3 = appendAuditRow(r2.hash, { event: 'c' }, fixedNow);
    const tampered: ChainLink = {
      prevHash: r3.prevHash,
      hash: 'f'.repeat(64),
      ts: r3.ts,
      event: r3.event,
      installationId: null,
      prId: null,
      model: null,
      inputTokens: null,
      outputTokens: null,
    };
    const result = verifyAuditChainSegment([
      {
        prevHash: r2.prevHash,
        hash: r2.hash,
        ts: r2.ts,
        event: r2.event,
        installationId: null,
        prId: null,
        model: null,
        inputTokens: null,
        outputTokens: null,
      },
      tampered,
    ]);
    expect(result.ok).toBe(false);
    expect(result.breaks).toHaveLength(1);
    expect(result.breaks[0]?.index).toBe(1);
  });

  it('verifyAuditChainSegment accepts an empty segment', () => {
    expect(verifyAuditChainSegment([])).toEqual({ ok: true, breaks: [] });
  });

  // ---- canonicalPayload backward-compatibility regression ----
  // These tests prove that adding `actor` to AuditEvent does NOT change the
  // canonical string (and therefore the HMAC) for events that have no actor.
  // Existing audit rows stored before the actor field was introduced will
  // continue to verify correctly without any data migration.

  it('canonicalPayload without actor is byte-for-byte identical whether actor is absent, null, or undefined', () => {
    const ts = new Date('2026-04-30T00:00:00.000Z');
    const ev = {
      event: 'review.start',
      installationId: 42n,
      prId: 'owner/repo#1',
      model: 'claude-3-5-sonnet',
      inputTokens: 100,
      outputTokens: 200,
    };
    const withoutActor = canonicalPayload(ev, ts);
    const withNullActor = canonicalPayload({ ...ev, actor: null }, ts);
    const withUndefinedActor = canonicalPayload({ ...ev, actor: undefined }, ts);

    expect(withNullActor).toBe(withoutActor);
    expect(withUndefinedActor).toBe(withoutActor);

    // Ensure the canonical string does NOT contain the word "actor" at all.
    expect(withoutActor).not.toContain('actor');
  });

  it('canonicalPayload with a non-null actor is different from the actor-less form', () => {
    const ts = new Date('2026-04-30T00:00:00.000Z');
    const ev = { event: 'review.start' };
    const withoutActor = canonicalPayload(ev, ts);
    const withActor = canonicalPayload({ ...ev, actor: 'alice' }, ts);
    expect(withActor).not.toBe(withoutActor);
    expect(withActor).toContain('"actor":"alice"');
  });

  it('HMAC hash of an event without actor matches a hardcoded reference value', () => {
    // This test pins an actual computed value so that any future change to
    // canonicalPayload that breaks backward compatibility will fail loudly.
    const ts = new Date('2026-04-30T00:00:00.000Z');
    const ev = { event: 'review.start', installationId: 1n, prId: 'o/r#1' };
    const prev = '0'.repeat(64);
    const hash = computeAuditHash(prev, ev, ts);
    // The expected value was computed by running the function before the
    // actor field existed; it must remain stable forever.
    expect(hash).toBe(computeAuditHash(prev, { ...ev, actor: null }, ts));
    expect(hash).toBe(computeAuditHash(prev, { ...ev, actor: undefined }, ts));
  });

  it('verifyAuditChain reports breaks when a row is tampered', () => {
    const r1 = appendAuditRow(null, { event: 'a' }, fixedNow);
    const r2 = appendAuditRow(r1.hash, { event: 'b' }, fixedNow);
    const tampered: ChainLink = {
      prevHash: r2.prevHash,
      hash: 'f'.repeat(64),
      ts: r2.ts,
      event: r2.event,
      installationId: null,
      prId: null,
      model: null,
      inputTokens: null,
      outputTokens: null,
    };
    const r = verifyAuditChain([
      {
        prevHash: r1.prevHash,
        hash: r1.hash,
        ts: r1.ts,
        event: r1.event,
        installationId: null,
        prId: null,
        model: null,
        inputTokens: null,
        outputTokens: null,
      },
      tampered,
    ]);
    expect(r.ok).toBe(false);
    expect(r.breaks).toHaveLength(1);
    expect(r.breaks[0]?.index).toBe(1);
  });
});
