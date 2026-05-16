import {
  createDbClient,
  type DbClient,
  type PruneAuditResult,
  type PruneCostResult,
  pruneAuditLog,
  pruneCostLedger,
  type SegmentVerificationReport,
  verifyAuditChainSegmentFromDb,
} from '@review-agent/db';
import type { ProgramIo } from '../io.js';

export type AuditPruneOpts = {
  readonly before: string;
  readonly confirm: boolean;
  readonly env: NodeJS.ProcessEnv;
  // Test seams — wire production deps via createDbClient by default.
  readonly createDb?: (url: string) => { db: DbClient; close: () => Promise<void> };
  readonly pruneAudit?: (db: DbClient, q: { before: Date }) => Promise<PruneAuditResult>;
  readonly pruneCost?: (db: DbClient, q: { before: Date }) => Promise<PruneCostResult>;
  readonly verifyChain?: (db: DbClient) => Promise<SegmentVerificationReport>;
};

export type AuditPruneResult = {
  readonly status: 'ok' | 'dry_run' | 'config_error' | 'invalid_args' | 'chain_break';
  readonly auditDeleted: number;
  readonly costDeleted: number;
  readonly anchorId: bigint | null;
  readonly anchorHash: string | null;
};

// `review-agent audit prune` — spec §13.3.
//
// Deletes audit_log + cost_ledger rows older than `--before`. The audit
// chain is preserved by keeping the most-recent row before the boundary
// as the new anchor: its hash remains a valid `prev_hash` reference for
// the surviving tail. After prune, the chain segment is re-verified;
// a break causes a fail-loud non-zero exit so operators investigate
// before assuming the pruned table is still integrity-clean.
//
// Without `--confirm` the command is a dry run that only reports what
// would be deleted, with no DB writes.
export async function auditPruneCommand(
  io: ProgramIo,
  opts: AuditPruneOpts,
): Promise<AuditPruneResult> {
  const before = parseIsoDate(opts.before);
  if (!before) {
    io.stderr(`--before must be an ISO date (got '${opts.before}').\n`);
    return {
      status: 'invalid_args',
      auditDeleted: 0,
      costDeleted: 0,
      anchorId: null,
      anchorHash: null,
    };
  }

  const url = opts.env.DATABASE_URL ?? opts.env.REVIEW_AGENT_DATABASE_URL;
  if (!url && !opts.createDb) {
    io.stderr('DATABASE_URL (or REVIEW_AGENT_DATABASE_URL) is required.\n');
    return {
      status: 'config_error',
      auditDeleted: 0,
      costDeleted: 0,
      anchorId: null,
      anchorHash: null,
    };
  }

  const makeDb = opts.createDb ?? ((u: string) => createDbClient({ url: u }));
  const { db, close } = makeDb(url ?? '');
  const doPruneAudit = opts.pruneAudit ?? pruneAuditLog;
  const doPruneCost = opts.pruneCost ?? pruneCostLedger;
  const verify = opts.verifyChain ?? ((d) => verifyAuditChainSegmentFromDb(d));

  try {
    if (!opts.confirm) {
      io.stdout(
        `Dry run: would prune audit_log + cost_ledger rows older than ${opts.before}. ` +
          `Re-run with --confirm to actually delete.\n`,
      );
      return {
        status: 'dry_run',
        auditDeleted: 0,
        costDeleted: 0,
        anchorId: null,
        anchorHash: null,
      };
    }

    const auditResult = await doPruneAudit(db, { before });
    const costResult = await doPruneCost(db, { before });

    const verification = await verify(db);
    if (!verification.ok) {
      const firstBreak = verification.breaks[0];
      io.stderr(
        `Chain verification FAILED after prune at row ${firstBreak?.index ?? '?'}. ` +
          'Operator must investigate before further appends.\n',
      );
      return {
        status: 'chain_break',
        auditDeleted: auditResult.deleted,
        costDeleted: costResult.deleted,
        anchorId: auditResult.anchorId,
        anchorHash: auditResult.anchorHash,
      };
    }

    io.stdout(
      `Pruned ${auditResult.deleted} audit_log row(s) and ${costResult.deleted} cost_ledger row(s) ` +
        `older than ${opts.before}. ` +
        (auditResult.anchorId !== null
          ? `Chain anchor: id=${auditResult.anchorId} hash=${auditResult.anchorHash?.slice(0, 12)}…\n`
          : 'No audit_log anchor (nothing to anchor).\n'),
    );

    return {
      status: 'ok',
      auditDeleted: auditResult.deleted,
      costDeleted: costResult.deleted,
      anchorId: auditResult.anchorId,
      anchorHash: auditResult.anchorHash,
    };
  } finally {
    await close();
  }
}

function parseIsoDate(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}(T.+)?$/.test(value)) return null;
  const parsed = value.includes('T') ? new Date(value) : new Date(`${value}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
