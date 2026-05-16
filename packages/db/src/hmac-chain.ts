import { AUDIT_GENESIS_HASH, type ChainLink, verifyAuditChainSegment } from '@review-agent/core';
import { auditLog } from '@review-agent/core/db';
import { asc, eq } from 'drizzle-orm';
import type { DbClient } from './connection.js';

export type SegmentVerificationReport = {
  readonly ok: boolean;
  readonly rowsChecked: number;
  readonly breaks: ReturnType<typeof verifyAuditChainSegment>['breaks'];
};

// Verify the audit_log chain treating whatever rows survive in the table
// as a (possibly pruned) segment. Used after `pruneAuditLog` to confirm
// the surviving tail is still internally consistent.
export async function verifyAuditChainSegmentFromDb(
  db: DbClient,
  opts: { installationId?: bigint } = {},
): Promise<SegmentVerificationReport> {
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
  const result = verifyAuditChainSegment(links);
  return { ok: result.ok, rowsChecked: links.length, breaks: result.breaks };
}
