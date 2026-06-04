import { AUDIT_GENESIS_HASH, type ChainLink, verifyAuditChainSegment } from '@review-agent/core';
import { auditLog } from '@review-agent/core/db';
import { asc, eq, sql } from 'drizzle-orm';
import type { DbClient } from './connection.js';
import { TENANT_GUC } from './tenancy.js';

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
  // Set the tenant GUC so the RLS `using` clause allows the SELECT.
  if (opts.installationId !== undefined) {
    const id = String(opts.installationId);
    await db.execute(sql`SELECT set_config(${TENANT_GUC}, ${id}, true)`);
  }
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
      actor: auditLog.actor,
      resourceType: auditLog.resourceType,
      resourceId: auditLog.resourceId,
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
    actor: r.actor,
    resourceType: r.resourceType,
    resourceId: r.resourceId,
  }));
  const result = verifyAuditChainSegment(links);
  return { ok: result.ok, rowsChecked: links.length, breaks: result.breaks };
}
