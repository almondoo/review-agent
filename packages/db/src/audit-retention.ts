import { auditLog, costLedger } from '@review-agent/core/db';
import { and, asc, eq, gte, lt, lte, sql } from 'drizzle-orm';
import type { DbClient } from './connection.js';

export type AuditLogExportRow = {
  readonly kind: 'audit';
  readonly id: bigint;
  readonly ts: Date;
  readonly installationId: bigint | null;
  readonly prId: string | null;
  readonly event: string;
  readonly model: string | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly prevHash: string | null;
  readonly hash: string;
};

export type CostLedgerExportRow = {
  readonly kind: 'cost';
  readonly id: bigint;
  readonly installationId: bigint;
  readonly jobId: string;
  readonly provider: string;
  readonly model: string;
  readonly callPhase: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
  readonly costUsd: number;
  readonly status: string;
  readonly createdAt: Date;
};

export type ExportRow = AuditLogExportRow | CostLedgerExportRow;

export type LoadExportOpts = {
  readonly installationId: bigint;
  readonly since: Date;
  readonly until?: Date;
};

export async function loadAuditLogForExport(
  db: DbClient,
  opts: LoadExportOpts,
): Promise<ReadonlyArray<AuditLogExportRow>> {
  const conditions = [
    eq(auditLog.installationId, opts.installationId),
    gte(auditLog.ts, opts.since),
  ];
  if (opts.until) conditions.push(lte(auditLog.ts, opts.until));
  const rows = await db
    .select({
      id: auditLog.id,
      ts: auditLog.ts,
      installationId: auditLog.installationId,
      prId: auditLog.prId,
      event: auditLog.event,
      model: auditLog.model,
      inputTokens: auditLog.inputTokens,
      outputTokens: auditLog.outputTokens,
      prevHash: auditLog.prevHash,
      hash: auditLog.hash,
    })
    .from(auditLog)
    .where(and(...conditions))
    .orderBy(asc(auditLog.id));
  return rows.map((r) => ({
    kind: 'audit' as const,
    id: r.id,
    ts: r.ts,
    installationId: r.installationId,
    prId: r.prId,
    event: r.event,
    model: r.model,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    prevHash: r.prevHash,
    hash: r.hash,
  }));
}

export async function loadCostLedgerForExport(
  db: DbClient,
  opts: LoadExportOpts,
): Promise<ReadonlyArray<CostLedgerExportRow>> {
  const conditions = [
    eq(costLedger.installationId, opts.installationId),
    gte(costLedger.createdAt, opts.since),
  ];
  if (opts.until) conditions.push(lte(costLedger.createdAt, opts.until));
  const rows = await db
    .select()
    .from(costLedger)
    .where(and(...conditions))
    .orderBy(asc(costLedger.id));
  return rows.map((r) => ({
    kind: 'cost' as const,
    id: r.id,
    installationId: r.installationId,
    jobId: r.jobId,
    provider: r.provider,
    model: r.model,
    callPhase: r.callPhase,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    cacheReadTokens: r.cacheReadTokens,
    cacheCreationTokens: r.cacheCreationTokens,
    costUsd: r.costUsd,
    status: r.status,
    createdAt: r.createdAt,
  }));
}

export type PruneAuditResult = {
  readonly deleted: number;
  readonly anchorId: bigint | null;
  readonly anchorHash: string | null;
};

// Prune audit_log rows older than `before` while preserving chain integrity.
// We keep the most-recent row with `ts < before` as the new anchor; that row
// stays in the table so its hash remains a valid `prev_hash` reference for
// the surviving tail. Rows strictly older than the anchor are deleted.
//
// If `before` is older than every row, nothing is deleted. If `before` is
// newer than every row, the most-recent row in the table becomes the anchor
// and all earlier rows are deleted.
export async function pruneAuditLog(
  db: DbClient,
  opts: { readonly before: Date },
): Promise<PruneAuditResult> {
  return db.transaction(async (tx) => {
    const anchorRows = await tx
      .select({ id: auditLog.id, hash: auditLog.hash })
      .from(auditLog)
      .where(lt(auditLog.ts, opts.before))
      .orderBy(sql`${auditLog.id} DESC`)
      .limit(1);
    const anchor = anchorRows[0];
    if (!anchor) {
      return { deleted: 0, anchorId: null, anchorHash: null };
    }
    const deletedRows = await tx
      .delete(auditLog)
      .where(lt(auditLog.id, anchor.id))
      .returning({ id: auditLog.id });
    return { deleted: deletedRows.length, anchorId: anchor.id, anchorHash: anchor.hash };
  });
}

export type PruneCostResult = {
  readonly deleted: number;
};

// Prune cost_ledger rows older than `before`. The ledger has no HMAC chain
// of its own — the audit_log is the integrity surface — so we delete every
// matching row without retaining an anchor.
export async function pruneCostLedger(
  db: DbClient,
  opts: { readonly before: Date },
): Promise<PruneCostResult> {
  const deletedRows = await db
    .delete(costLedger)
    .where(lt(costLedger.createdAt, opts.before))
    .returning({ id: costLedger.id });
  return { deleted: deletedRows.length };
}
