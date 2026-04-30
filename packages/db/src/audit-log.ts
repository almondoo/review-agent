import {
  AUDIT_GENESIS_HASH,
  type AuditEvent,
  type AuditRow,
  appendAuditRow,
  type ChainLink,
  verifyAuditChain,
} from '@review-agent/core';
import { auditLog, type NewAuditLogRow } from '@review-agent/core/db';
import { asc, eq, sql } from 'drizzle-orm';
import type { DbClient } from './connection.js';

export type AuditAppender = (event: AuditEvent) => Promise<AuditRow>;

export function createAuditAppender(
  db: DbClient,
  now: () => Date = () => new Date(),
): AuditAppender {
  return async (event) => {
    return db.transaction(async (tx) => {
      const lastRows = await tx
        .select({ hash: auditLog.hash })
        .from(auditLog)
        .orderBy(sql`${auditLog.id} DESC`)
        .limit(1);
      const prevHash = lastRows[0]?.hash ?? null;
      const row = appendAuditRow(prevHash, event, now);
      const insertRow: NewAuditLogRow = {
        ts: row.ts,
        installationId: row.installationId ?? null,
        prId: row.prId ?? null,
        event: row.event,
        model: row.model ?? null,
        inputTokens: row.inputTokens ?? null,
        outputTokens: row.outputTokens ?? null,
        prevHash: row.prevHash,
        hash: row.hash,
      };
      await tx.insert(auditLog).values(insertRow);
      return row;
    });
  };
}

export type ChainVerificationReport = {
  readonly ok: boolean;
  readonly rowsChecked: number;
  readonly breaks: ReturnType<typeof verifyAuditChain>['breaks'];
};

export async function verifyAuditChainFromDb(
  db: DbClient,
  opts: { installationId?: bigint } = {},
): Promise<ChainVerificationReport> {
  const where =
    opts.installationId !== undefined
      ? eq(auditLog.installationId, opts.installationId)
      : undefined;
  const query = db
    .select({
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
    .orderBy(asc(auditLog.id));
  const rows = where ? await query.where(where) : await query;
  const links: ChainLink[] = rows.map((r) => ({
    prevHash: r.prevHash ?? AUDIT_GENESIS_HASH,
    hash: r.hash,
    ts: r.ts,
    event: r.event,
    installationId: r.installationId,
    prId: r.prId,
    model: r.model,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
  }));
  const result = verifyAuditChain(links);
  return { ok: result.ok, rowsChecked: links.length, breaks: result.breaks };
}
