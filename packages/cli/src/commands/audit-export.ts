import { writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';
import { AUDIT_GENESIS_HASH, type ChainLink, verifyAuditChainSegment } from '@review-agent/core';
import {
  type AuditLogExportRow,
  type CostLedgerExportRow,
  createDbClient,
  type DbClient,
  type LoadExportOpts,
  loadAuditLogForExport,
  loadCostLedgerForExport,
} from '@review-agent/db';
import type { ProgramIo } from '../io.js';

const gzipAsync = promisify(gzip);

export type AuditExportOpts = {
  readonly installationId: bigint;
  readonly since: string;
  readonly until?: string;
  readonly output: string;
  readonly env: NodeJS.ProcessEnv;
  // Test seams — wire production deps via createDbClient by default.
  readonly loadAuditRows?: (
    db: DbClient,
    q: LoadExportOpts,
  ) => Promise<ReadonlyArray<AuditLogExportRow>>;
  readonly loadCostRows?: (
    db: DbClient,
    q: LoadExportOpts,
  ) => Promise<ReadonlyArray<CostLedgerExportRow>>;
  readonly createDb?: (url: string) => { db: DbClient; close: () => Promise<void> };
  readonly writeOutput?: (path: string, data: Buffer) => Promise<void>;
};

export type AuditExportResult = {
  readonly status: 'ok' | 'config_error' | 'chain_break' | 'invalid_args';
  readonly auditRows: number;
  readonly costRows: number;
  readonly path?: string;
};

// `review-agent audit export` — spec §13.3.
//
// Exports both audit_log and cost_ledger for the requested installation and
// date range as gzipped JSONL. Each line is a discriminated object
// (`kind: 'audit' | 'cost'`). The audit_log slice is verified as a chain
// segment before export — operators want to know up front if the chain
// they're archiving is already broken, not later when the verifier
// flags it during retention audits.
export async function auditExportCommand(
  io: ProgramIo,
  opts: AuditExportOpts,
): Promise<AuditExportResult> {
  const since = parseIsoDate(opts.since);
  if (!since) {
    io.stderr(`--since must be an ISO date (got '${opts.since}').\n`);
    return { status: 'invalid_args', auditRows: 0, costRows: 0 };
  }
  let until: Date | undefined;
  if (opts.until !== undefined) {
    const parsed = parseIsoDate(opts.until);
    if (!parsed) {
      io.stderr(`--until must be an ISO date (got '${opts.until}').\n`);
      return { status: 'invalid_args', auditRows: 0, costRows: 0 };
    }
    until = parsed;
  }

  const url = opts.env.DATABASE_URL ?? opts.env.REVIEW_AGENT_DATABASE_URL;
  if (!url && !opts.createDb) {
    io.stderr('DATABASE_URL (or REVIEW_AGENT_DATABASE_URL) is required.\n');
    return { status: 'config_error', auditRows: 0, costRows: 0 };
  }

  const makeDb = opts.createDb ?? ((u: string) => createDbClient({ url: u }));
  const { db, close } = makeDb(url ?? '');
  const loadAudit = opts.loadAuditRows ?? loadAuditLogForExport;
  const loadCost = opts.loadCostRows ?? loadCostLedgerForExport;
  const write = opts.writeOutput ?? writeFile;

  try {
    const loadOpts: LoadExportOpts = until
      ? { installationId: opts.installationId, since, until }
      : { installationId: opts.installationId, since };
    const [auditRows, costRows] = await Promise.all([
      loadAudit(db, loadOpts),
      loadCost(db, loadOpts),
    ]);

    if (auditRows.length > 0) {
      const links: ChainLink[] = auditRows.map((r) => ({
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
      const verification = verifyAuditChainSegment(links);
      if (!verification.ok) {
        const firstBreak = verification.breaks[0];
        io.stderr(
          `audit_log chain segment is broken at row ${firstBreak?.index ?? '?'} ` +
            `(expected ${firstBreak?.expected ?? '?'}, got ${firstBreak?.actual ?? '?'}). ` +
            'Refusing to write a tainted export.\n',
        );
        return {
          status: 'chain_break',
          auditRows: auditRows.length,
          costRows: costRows.length,
        };
      }
    }

    const lines: string[] = [];
    for (const row of auditRows) lines.push(jsonLine(row));
    for (const row of costRows) lines.push(jsonLine(row));
    const payload = `${lines.join('\n')}${lines.length > 0 ? '\n' : ''}`;
    const buf = await gzipAsync(Buffer.from(payload, 'utf8'));
    await write(opts.output, buf);

    io.stdout(
      `Exported ${auditRows.length} audit_log row(s) and ${costRows.length} cost_ledger row(s) ` +
        `for installation ${opts.installationId} to ${opts.output}\n`,
    );
    return {
      status: 'ok',
      auditRows: auditRows.length,
      costRows: costRows.length,
      path: opts.output,
    };
  } finally {
    await close();
  }
}

function parseIsoDate(value: string): Date | null {
  // Accept YYYY-MM-DD (UTC midnight) and full ISO 8601. Reject anything
  // else — silent reinterpretation of operator-supplied dates is exactly
  // the kind of bug that wrecks an audit export.
  if (!/^\d{4}-\d{2}-\d{2}(T.+)?$/.test(value)) return null;
  const parsed = value.includes('T') ? new Date(value) : new Date(`${value}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function jsonLine(value: unknown): string {
  return JSON.stringify(value, (_key, v) => (typeof v === 'bigint' ? v.toString() : v));
}
