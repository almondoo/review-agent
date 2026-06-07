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
import { TENANT_GUC } from './tenancy.js';

export type AuditAppender = (event: AuditEvent) => Promise<AuditRow>;

export function createAuditAppender(
  db: DbClient,
  now: () => Date = () => new Date(),
): AuditAppender {
  return async (event) => {
    return db.transaction(async (tx) => {
      // Set the tenant GUC so the RLS `tenant_isolation` policy sees the correct
      // installation_id for both the prev_hash SELECT and the INSERT.
      //   - Non-null installationId: scopes prev_hash to this installation's chain
      //     and satisfies `withCheck = installation_id IS NULL OR installation_id::text
      //     = current_setting(...)`.
      //   - Null installationId: GUC intentionally left unset (system/global events).
      //     The withCheck `IS NULL` branch allows the INSERT without a GUC value; the
      //     `using` clause means these rows are write-only under RLS (not visible to
      //     tenant-scoped SELECT). This is the documented limitation for global events
      //     (e.g. principal.create without an installation).
      if (event.installationId != null) {
        const id = String(event.installationId);
        await tx.execute(sql`SELECT set_config(${TENANT_GUC}, ${id}, true)`);
      }
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
        actor: row.actor ?? null,
        resourceType: row.resourceType ?? null,
        resourceId: row.resourceId ?? null,
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
  // Set the tenant GUC so the RLS `using` clause allows the SELECT.
  // Without it the policy sees current_setting(...)=NULL which matches no rows.
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
  const result = verifyAuditChain(links);
  return { ok: result.ok, rowsChecked: links.length, breaks: result.breaks };
}
