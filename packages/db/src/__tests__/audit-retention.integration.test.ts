import { promisify } from 'node:util';
import { gunzipSync, gzip } from 'node:zlib';
import { AUDIT_GENESIS_HASH, type ChainLink, verifyAuditChainSegment } from '@review-agent/core';
import { costLedger } from '@review-agent/core/db';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createAuditAppender } from '../audit-log.js';
import {
  loadAuditLogForExport,
  loadCostLedgerForExport,
  pruneAuditLog,
  pruneCostLedger,
} from '../audit-retention.js';
import { createDbClient } from '../connection.js';
import { verifyAuditChainSegmentFromDb } from '../hmac-chain.js';

const url = process.env.TEST_DATABASE_URL ?? '';
const gzipAsync = promisify(gzip);

// Distinct installation_id so this test never collides with neighbouring
// integration suites that seed installation 1n.
const TEST_INSTALL = 877_001n;

// Build a synthetic clock that advances by a fixed step, so we can divide
// rows into "before" and "after" a chosen prune boundary deterministically.
function makeClock(start: Date, stepMs: number): () => Date {
  let i = -1;
  return () => {
    i += 1;
    return new Date(start.getTime() + i * stepMs);
  };
}

describe.skipIf(!url)('audit retention integration (1000 → 100 prune)', () => {
  it('preserves chain integrity post-prune and roundtrips export', async () => {
    const { db, close } = createDbClient({ url });
    try {
      // Reset state — owning a dedicated installation_id keeps this safe
      // across reruns; we delete only what this suite created.
      await db.execute(sql`DELETE FROM audit_log WHERE installation_id = ${TEST_INSTALL}`);
      await db.execute(sql`DELETE FROM cost_ledger WHERE installation_id = ${TEST_INSTALL}`);

      const startTs = new Date('2026-01-01T00:00:00.000Z');
      const clock = makeClock(startTs, 60_000); // 1-minute spacing → 1000 rows = ~16.7 hours
      const append = createAuditAppender(db, clock);

      for (let i = 0; i < 1000; i += 1) {
        await append({
          installationId: TEST_INSTALL,
          prId: `o/r#${i}`,
          event: `synthetic.${i}`,
          model: 'claude-sonnet-test',
          inputTokens: i,
          outputTokens: i * 2,
        });
        // Each audit row gets a paired cost_ledger row.
        await db.insert(costLedger).values({
          installationId: TEST_INSTALL,
          jobId: `job-${i}`,
          provider: 'anthropic',
          model: 'claude-sonnet-test',
          callPhase: 'review_main',
          inputTokens: i,
          outputTokens: i * 2,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          costUsd: 0.0001,
          status: 'success',
        });
      }

      // Sanity check: chain verifies before any pruning.
      const fullChain = await verifyAuditChainSegmentFromDb(db, {
        installationId: TEST_INSTALL,
      });
      expect(fullChain.ok).toBe(true);
      expect(fullChain.rowsChecked).toBe(1000);

      // Boundary chosen to leave exactly 100 rows after the anchor — i.e.
      // anchor + 100 surviving rows is preserved.
      const boundary = new Date(startTs.getTime() + 900 * 60_000);

      const auditPrune = await pruneAuditLog(db, { before: boundary });
      const costPrune = await pruneCostLedger(db, { before: boundary });

      expect(auditPrune.deleted).toBe(899);
      expect(auditPrune.anchorId).not.toBeNull();
      expect(costPrune.deleted).toBe(900);

      // Verify chain still verifies on the surviving anchor + 100-row tail.
      const postPrune = await verifyAuditChainSegmentFromDb(db, {
        installationId: TEST_INSTALL,
      });
      expect(postPrune.ok).toBe(true);
      expect(postPrune.rowsChecked).toBe(101);

      // Roundtrip export: load → gzip JSONL → decompress → parse → re-verify.
      const auditRows = await loadAuditLogForExport(db, {
        installationId: TEST_INSTALL,
        since: startTs,
      });
      const costRows = await loadCostLedgerForExport(db, {
        installationId: TEST_INSTALL,
        since: startTs,
      });
      expect(auditRows.length).toBe(101);
      expect(costRows.length).toBe(100);

      const lines = [...auditRows, ...costRows].map((r) =>
        JSON.stringify(r, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
      );
      const payload = `${lines.join('\n')}\n`;
      const buf = await gzipAsync(Buffer.from(payload, 'utf8'));
      const restored = gunzipSync(buf)
        .toString('utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l));
      expect(restored).toHaveLength(201);

      // Rebuild a ChainLink array from the audit rows in the gzipped export
      // and re-verify the chain segment matches what's in the DB.
      const restoredAudit = restored.filter((r) => r.kind === 'audit');
      const links: ChainLink[] = restoredAudit.map((r) => ({
        prevHash: r.prevHash ?? AUDIT_GENESIS_HASH,
        hash: r.hash,
        ts: new Date(r.ts),
        event: r.event,
        installationId: r.installationId === null ? null : BigInt(r.installationId),
        prId: r.prId,
        model: r.model,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
      }));
      expect(verifyAuditChainSegment(links).ok).toBe(true);
    } finally {
      // Clean up to keep the test DB tidy across reruns.
      await db.execute(sql`DELETE FROM audit_log WHERE installation_id = ${TEST_INSTALL}`);
      await db.execute(sql`DELETE FROM cost_ledger WHERE installation_id = ${TEST_INSTALL}`);
      await close();
    }
  }, 60_000);
});
