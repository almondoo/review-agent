import type {
  DbClient,
  PruneAuditResult,
  PruneCostResult,
  SegmentVerificationReport,
} from '@review-agent/db';
import { describe, expect, it, vi } from 'vitest';
import { auditPruneCommand } from './audit-prune.js';

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
const fakeCreateDb = () => ({ db: fakeDb, close: async () => undefined });
const okVerify = async (): Promise<SegmentVerificationReport> => ({
  ok: true,
  rowsChecked: 0,
  breaks: [],
});

describe('auditPruneCommand', () => {
  it('rejects malformed --before', async () => {
    const io = recordingIo();
    const result = await auditPruneCommand(io, {
      before: 'never',
      confirm: false,
      env: { DATABASE_URL: 'postgres://x' } as NodeJS.ProcessEnv,
      createDb: fakeCreateDb,
    });
    expect(result.status).toBe('invalid_args');
    expect(io.err.join('')).toContain('--before');
  });

  it('reports config_error without DATABASE_URL', async () => {
    const io = recordingIo();
    const result = await auditPruneCommand(io, {
      before: '2026-01-01',
      confirm: true,
      env: {} as NodeJS.ProcessEnv,
    });
    expect(result.status).toBe('config_error');
    expect(io.err.join('')).toContain('DATABASE_URL');
  });

  it('dry-runs without --confirm (no deletes called)', async () => {
    const io = recordingIo();
    const pruneAudit = vi.fn(
      async (): Promise<PruneAuditResult> => ({
        deleted: 0,
        anchorId: null,
        anchorHash: null,
      }),
    );
    const pruneCost = vi.fn(async (): Promise<PruneCostResult> => ({ deleted: 0 }));
    const result = await auditPruneCommand(io, {
      before: '2026-01-01',
      confirm: false,
      env: { DATABASE_URL: 'postgres://x' } as NodeJS.ProcessEnv,
      createDb: fakeCreateDb,
      pruneAudit,
      pruneCost,
      verifyChain: okVerify,
    });
    expect(result.status).toBe('dry_run');
    expect(pruneAudit).not.toHaveBeenCalled();
    expect(pruneCost).not.toHaveBeenCalled();
    expect(io.out.join('')).toContain('Dry run');
  });

  it('deletes both tables under --confirm and reports the anchor', async () => {
    const io = recordingIo();
    const pruneAudit = vi.fn(
      async (): Promise<PruneAuditResult> => ({
        deleted: 900,
        anchorId: 901n,
        anchorHash: 'a'.repeat(64),
      }),
    );
    const pruneCost = vi.fn(async (): Promise<PruneCostResult> => ({ deleted: 900 }));
    const result = await auditPruneCommand(io, {
      before: '2026-01-01',
      confirm: true,
      env: { DATABASE_URL: 'postgres://x' } as NodeJS.ProcessEnv,
      createDb: fakeCreateDb,
      pruneAudit,
      pruneCost,
      verifyChain: okVerify,
    });
    expect(result.status).toBe('ok');
    expect(result.auditDeleted).toBe(900);
    expect(result.costDeleted).toBe(900);
    expect(result.anchorId).toBe(901n);
    expect(pruneAudit).toHaveBeenCalledOnce();
    expect(pruneCost).toHaveBeenCalledOnce();
    expect(io.out.join('')).toContain('Chain anchor');
  });

  it('reports no-anchor when there were no audit rows to prune', async () => {
    const io = recordingIo();
    const pruneAudit = async (): Promise<PruneAuditResult> => ({
      deleted: 0,
      anchorId: null,
      anchorHash: null,
    });
    const pruneCost = async (): Promise<PruneCostResult> => ({ deleted: 0 });
    const result = await auditPruneCommand(io, {
      before: '2026-01-01',
      confirm: true,
      env: { DATABASE_URL: 'postgres://x' } as NodeJS.ProcessEnv,
      createDb: fakeCreateDb,
      pruneAudit,
      pruneCost,
      verifyChain: okVerify,
    });
    expect(result.status).toBe('ok');
    expect(io.out.join('')).toContain('No audit_log anchor');
  });

  it('fail-loud when chain verification breaks after prune', async () => {
    const io = recordingIo();
    const result = await auditPruneCommand(io, {
      before: '2026-01-01',
      confirm: true,
      env: { DATABASE_URL: 'postgres://x' } as NodeJS.ProcessEnv,
      createDb: fakeCreateDb,
      pruneAudit: async () => ({ deleted: 10, anchorId: 11n, anchorHash: 'b'.repeat(64) }),
      pruneCost: async () => ({ deleted: 10 }),
      verifyChain: async () => ({
        ok: false,
        rowsChecked: 5,
        breaks: [
          {
            index: 2,
            expected: 'a'.repeat(64),
            actual: 'b'.repeat(64),
            row: {
              prevHash: null,
              hash: 'b'.repeat(64),
              ts: new Date('2026-04-30T00:00:00Z'),
              event: 'x',
              installationId: null,
              prId: null,
              model: null,
              inputTokens: null,
              outputTokens: null,
            },
          },
        ],
      }),
    });
    expect(result.status).toBe('chain_break');
    expect(io.err.join('')).toContain('Chain verification FAILED');
    // Even on chain_break we still surface the delete counts so operators
    // can reconcile what was lost before the failure.
    expect(result.auditDeleted).toBe(10);
    expect(result.costDeleted).toBe(10);
  });

  it('closes the DB even when prune throws', async () => {
    const io = recordingIo();
    const close = vi.fn(async () => undefined);
    await expect(() =>
      auditPruneCommand(io, {
        before: '2026-01-01',
        confirm: true,
        env: { DATABASE_URL: 'postgres://x' } as NodeJS.ProcessEnv,
        createDb: () => ({ db: fakeDb, close }),
        pruneAudit: async () => {
          throw new Error('db down');
        },
        pruneCost: async () => ({ deleted: 0 }),
        verifyChain: okVerify,
      }),
    ).rejects.toThrow(/db down/);
    expect(close).toHaveBeenCalledOnce();
  });

  it('accepts REVIEW_AGENT_DATABASE_URL as a fallback for DATABASE_URL', async () => {
    const io = recordingIo();
    const result = await auditPruneCommand(io, {
      before: '2026-01-01',
      confirm: false,
      env: { REVIEW_AGENT_DATABASE_URL: 'postgres://x' } as NodeJS.ProcessEnv,
      createDb: fakeCreateDb,
    });
    expect(result.status).toBe('dry_run');
  });
});
