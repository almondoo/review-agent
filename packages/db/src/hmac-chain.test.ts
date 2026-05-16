import { appendAuditRow } from '@review-agent/core';
import { describe, expect, it } from 'vitest';
import type { DbClient } from './connection.js';
import { verifyAuditChainSegmentFromDb } from './hmac-chain.js';

type AuditRowShape = {
  ts: Date;
  installationId: bigint | null;
  prId: string | null;
  event: string;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  prevHash: string | null;
  hash: string;
};

// Build a fake DbClient that satisfies the exact query chain
// verifyAuditChainSegmentFromDb makes. Both branches (with `.where()` and
// without) ultimately need `await query` to resolve to the rows array, so
// `.orderBy()` returns an object that is both awaitable AND exposes
// `.where()` returning a Promise. We use real Promises (no thenables on
// plain objects) so we don't trip `noThenProperty`.
function fakeDb(rows: AuditRowShape[]): DbClient {
  const builder: {
    where: () => Promise<AuditRowShape[]>;
  } & PromiseLike<AuditRowShape[]> = Object.assign(Promise.resolve(rows), {
    where: () => Promise.resolve(rows),
  });
  const queryBuilder = {
    from: () => ({
      orderBy: () => builder,
    }),
  };
  const db = {
    select: () => queryBuilder,
  };
  return db as unknown as DbClient;
}

const fixedNow = () => new Date('2026-04-30T00:00:00.000Z');

describe('verifyAuditChainSegmentFromDb', () => {
  it('returns ok for an empty result set', async () => {
    const report = await verifyAuditChainSegmentFromDb(fakeDb([]));
    expect(report).toEqual({ ok: true, rowsChecked: 0, breaks: [] });
  });

  it('verifies a valid chain segment', async () => {
    const r1 = appendAuditRow(null, { event: 'a' }, fixedNow);
    const r2 = appendAuditRow(r1.hash, { event: 'b' }, fixedNow);
    const rows: AuditRowShape[] = [r1, r2].map((r) => ({
      ts: r.ts,
      installationId: r.installationId ?? null,
      prId: r.prId ?? null,
      event: r.event,
      model: r.model ?? null,
      inputTokens: r.inputTokens ?? null,
      outputTokens: r.outputTokens ?? null,
      prevHash: r.prevHash,
      hash: r.hash,
    }));
    const report = await verifyAuditChainSegmentFromDb(fakeDb(rows));
    expect(report.ok).toBe(true);
    expect(report.rowsChecked).toBe(2);
  });

  it('reports a break when a row is tampered', async () => {
    const r1 = appendAuditRow(null, { event: 'a' }, fixedNow);
    const r2 = appendAuditRow(r1.hash, { event: 'b' }, fixedNow);
    const rows: AuditRowShape[] = [
      {
        ts: r1.ts,
        installationId: null,
        prId: null,
        event: r1.event,
        model: null,
        inputTokens: null,
        outputTokens: null,
        prevHash: r1.prevHash,
        hash: r1.hash,
      },
      {
        ts: r2.ts,
        installationId: null,
        prId: null,
        event: r2.event,
        model: null,
        inputTokens: null,
        outputTokens: null,
        prevHash: r2.prevHash,
        hash: 'f'.repeat(64),
      },
    ];
    const report = await verifyAuditChainSegmentFromDb(fakeDb(rows));
    expect(report.ok).toBe(false);
    expect(report.breaks).toHaveLength(1);
  });

  it('runs the installation_id branch when given an installationId', async () => {
    const r1 = appendAuditRow(null, { event: 'a', installationId: 7n }, fixedNow);
    const rows: AuditRowShape[] = [
      {
        ts: r1.ts,
        installationId: r1.installationId ?? null,
        prId: null,
        event: r1.event,
        model: null,
        inputTokens: null,
        outputTokens: null,
        prevHash: r1.prevHash,
        hash: r1.hash,
      },
    ];
    const report = await verifyAuditChainSegmentFromDb(fakeDb(rows), { installationId: 7n });
    expect(report.ok).toBe(true);
    expect(report.rowsChecked).toBe(1);
  });
});
