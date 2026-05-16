import { gunzipSync } from 'node:zlib';
import { appendAuditRow } from '@review-agent/core';
import type {
  AuditLogExportRow,
  CostLedgerExportRow,
  DbClient,
  LoadExportOpts,
} from '@review-agent/db';
import { describe, expect, it, vi } from 'vitest';
import { auditExportCommand } from './audit-export.js';

function recordingIo() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    stdout: (c: string) => {
      out.push(c);
    },
    stderr: (c: string) => {
      err.push(c);
    },
    exit: () => {},
  };
}

const fakeDb = {} as DbClient;

function fakeCreateDb() {
  return { db: fakeDb, close: async () => undefined };
}

function fakeAudit(rows: ReadonlyArray<AuditLogExportRow>) {
  return async (_db: DbClient, _q: LoadExportOpts) => rows;
}
function fakeCost(rows: ReadonlyArray<CostLedgerExportRow>) {
  return async (_db: DbClient, _q: LoadExportOpts) => rows;
}

// Build a small valid audit chain so the verifier passes.
function buildAuditChain(n: number, installationId = 7n): AuditLogExportRow[] {
  const now = () => new Date('2026-04-30T00:00:00.000Z');
  const rows: AuditLogExportRow[] = [];
  let prev: string | null = null;
  for (let i = 0; i < n; i += 1) {
    const ev = {
      installationId,
      prId: `o/r#${i}`,
      event: `e${i}`,
      model: null,
      inputTokens: null,
      outputTokens: null,
    };
    const r = appendAuditRow(prev, ev, now);
    rows.push({
      kind: 'audit',
      id: BigInt(i + 1),
      ts: r.ts,
      installationId: r.installationId ?? null,
      prId: r.prId ?? null,
      event: r.event,
      model: r.model ?? null,
      inputTokens: r.inputTokens ?? null,
      outputTokens: r.outputTokens ?? null,
      prevHash: r.prevHash,
      hash: r.hash,
    });
    prev = r.hash;
  }
  return rows;
}

describe('auditExportCommand', () => {
  it('rejects --since values that are not ISO-shaped', async () => {
    const io = recordingIo();
    const result = await auditExportCommand(io, {
      installationId: 1n,
      since: 'yesterday',
      output: 'tmp/out.jsonl.gz',
      env: { DATABASE_URL: 'postgres://x' } as NodeJS.ProcessEnv,
      createDb: fakeCreateDb,
      loadAuditRows: fakeAudit([]),
      loadCostRows: fakeCost([]),
      writeOutput: async () => undefined,
    });
    expect(result.status).toBe('invalid_args');
    expect(io.err.join('')).toContain('--since');
  });

  it('rejects --until values that are not ISO-shaped', async () => {
    const io = recordingIo();
    const result = await auditExportCommand(io, {
      installationId: 1n,
      since: '2026-01-01',
      until: 'never',
      output: 'tmp/out.jsonl.gz',
      env: { DATABASE_URL: 'postgres://x' } as NodeJS.ProcessEnv,
      createDb: fakeCreateDb,
      loadAuditRows: fakeAudit([]),
      loadCostRows: fakeCost([]),
      writeOutput: async () => undefined,
    });
    expect(result.status).toBe('invalid_args');
    expect(io.err.join('')).toContain('--until');
  });

  it('reports config_error without DATABASE_URL', async () => {
    const io = recordingIo();
    const result = await auditExportCommand(io, {
      installationId: 1n,
      since: '2026-01-01',
      output: 'tmp/out.jsonl.gz',
      env: {} as NodeJS.ProcessEnv,
    });
    expect(result.status).toBe('config_error');
    expect(io.err.join('')).toContain('DATABASE_URL');
  });

  it('writes a gzipped JSONL roundtrip with audit + cost rows', async () => {
    const io = recordingIo();
    const audit = buildAuditChain(3);
    const cost: CostLedgerExportRow[] = [
      {
        kind: 'cost',
        id: 1n,
        installationId: 7n,
        jobId: 'job-1',
        provider: 'anthropic',
        model: 'claude-sonnet',
        callPhase: 'review_main',
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUsd: 0.01,
        status: 'success',
        createdAt: new Date('2026-04-30T00:00:00Z'),
      },
    ];
    let written: { path: string; data: Buffer } | null = null;
    const result = await auditExportCommand(io, {
      installationId: 7n,
      since: '2026-01-01',
      until: '2026-12-31T23:59:59Z',
      output: 'tmp/out.jsonl.gz',
      env: { DATABASE_URL: 'postgres://x' } as NodeJS.ProcessEnv,
      createDb: fakeCreateDb,
      loadAuditRows: fakeAudit(audit),
      loadCostRows: fakeCost(cost),
      writeOutput: async (path, data) => {
        written = { path, data };
      },
    });
    expect(result.status).toBe('ok');
    expect(result.auditRows).toBe(3);
    expect(result.costRows).toBe(1);
    expect(written).not.toBeNull();
    expect((written as unknown as { path: string }).path).toBe('tmp/out.jsonl.gz');
    const decompressed = gunzipSync((written as unknown as { data: Buffer }).data).toString('utf8');
    const lines = decompressed.trim().split('\n');
    expect(lines).toHaveLength(4);
    const parsed = lines.map((l) => JSON.parse(l));
    expect(parsed[0]).toMatchObject({ kind: 'audit', event: 'e0', installationId: '7' });
    expect(parsed[3]).toMatchObject({ kind: 'cost', jobId: 'job-1', installationId: '7' });
  });

  it('writes an empty gzip when there are no rows', async () => {
    const io = recordingIo();
    let written: Buffer | null = null;
    const result = await auditExportCommand(io, {
      installationId: 7n,
      since: '2026-01-01',
      output: 'tmp/empty.jsonl.gz',
      env: { DATABASE_URL: 'postgres://x' } as NodeJS.ProcessEnv,
      createDb: fakeCreateDb,
      loadAuditRows: fakeAudit([]),
      loadCostRows: fakeCost([]),
      writeOutput: async (_p, data) => {
        written = data;
      },
    });
    expect(result.status).toBe('ok');
    expect(result.auditRows).toBe(0);
    expect(result.costRows).toBe(0);
    expect(gunzipSync(written as unknown as Buffer).toString('utf8')).toBe('');
  });

  it('refuses to write when the audit chain segment is broken', async () => {
    const io = recordingIo();
    const audit = buildAuditChain(3);
    const tampered = audit.map((r, i) => (i === 1 ? { ...r, hash: 'f'.repeat(64) } : r));
    const write = vi.fn(async () => undefined);
    const result = await auditExportCommand(io, {
      installationId: 7n,
      since: '2026-01-01',
      output: 'tmp/out.jsonl.gz',
      env: { DATABASE_URL: 'postgres://x' } as NodeJS.ProcessEnv,
      createDb: fakeCreateDb,
      loadAuditRows: fakeAudit(tampered),
      loadCostRows: fakeCost([]),
      writeOutput: write,
    });
    expect(result.status).toBe('chain_break');
    // Critical: we must NOT have written a tainted file.
    expect(write).not.toHaveBeenCalled();
    expect(io.err.join('')).toContain('chain segment is broken');
  });

  it('closes the DB even when the export throws', async () => {
    const io = recordingIo();
    const close = vi.fn(async () => undefined);
    const audit = buildAuditChain(2);
    await expect(() =>
      auditExportCommand(io, {
        installationId: 7n,
        since: '2026-01-01',
        output: 'tmp/out.jsonl.gz',
        env: { DATABASE_URL: 'postgres://x' } as NodeJS.ProcessEnv,
        createDb: () => ({ db: fakeDb, close }),
        loadAuditRows: fakeAudit(audit),
        loadCostRows: async () => {
          throw new Error('boom');
        },
        writeOutput: async () => undefined,
      }),
    ).rejects.toThrow(/boom/);
    expect(close).toHaveBeenCalledOnce();
  });

  it('accepts REVIEW_AGENT_DATABASE_URL as a fallback for DATABASE_URL', async () => {
    const io = recordingIo();
    const result = await auditExportCommand(io, {
      installationId: 7n,
      since: '2026-01-01',
      output: 'tmp/out.jsonl.gz',
      env: { REVIEW_AGENT_DATABASE_URL: 'postgres://x' } as NodeJS.ProcessEnv,
      createDb: fakeCreateDb,
      loadAuditRows: fakeAudit([]),
      loadCostRows: fakeCost([]),
      writeOutput: async () => undefined,
    });
    expect(result.status).toBe('ok');
  });
});
