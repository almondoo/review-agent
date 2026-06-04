import type { DbClient } from '@review-agent/db';
import { describe, expect, it, vi } from 'vitest';
import { suppressionRemoveCommand } from './suppression-remove.js';

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

describe('suppressionRemoveCommand', () => {
  it('returns config_error when DATABASE_URL is missing', async () => {
    const io = recordingIo();
    const result = await suppressionRemoveCommand(io, {
      installationId: 1n,
      repo: 'org/repo',
      ruleId: 42n,
      env: {} as NodeJS.ProcessEnv,
    });
    expect(result.status).toBe('config_error');
    expect(io.err.join('')).toContain('DATABASE_URL');
  });

  it('accepts REVIEW_AGENT_DATABASE_URL as a fallback', async () => {
    const io = recordingIo();
    const result = await suppressionRemoveCommand(io, {
      installationId: 1n,
      repo: 'org/repo',
      ruleId: 1n,
      env: { REVIEW_AGENT_DATABASE_URL: 'postgres://x' } as NodeJS.ProcessEnv,
      createDb: fakeCreateDb,
      deleteRule: async () => true,
    });
    expect(result.status).toBe('ok');
  });

  it('returns ok and prints confirmation when rule is deleted', async () => {
    const io = recordingIo();
    const deleteRule = vi.fn(async () => true);
    const result = await suppressionRemoveCommand(io, {
      installationId: 1n,
      repo: 'org/repo',
      ruleId: 42n,
      env: { DATABASE_URL: 'postgres://x' } as NodeJS.ProcessEnv,
      createDb: fakeCreateDb,
      deleteRule,
    });
    expect(result.status).toBe('ok');
    const output = io.out.join('');
    expect(output).toContain('42');
    expect(output).toContain('removed');
    expect(output).toContain('org/repo');
    expect(deleteRule).toHaveBeenCalledWith(fakeDb, {
      id: 42n,
      installationId: 1n,
      repo: 'org/repo',
    });
  });

  it('returns not_found when the rule does not exist', async () => {
    const io = recordingIo();
    const result = await suppressionRemoveCommand(io, {
      installationId: 1n,
      repo: 'org/repo',
      ruleId: 999n,
      env: { DATABASE_URL: 'postgres://x' } as NodeJS.ProcessEnv,
      createDb: fakeCreateDb,
      deleteRule: async () => false,
    });
    expect(result.status).toBe('not_found');
    expect(io.out.join('')).toContain('not found');
  });

  it('closes the DB even when deleteRule throws', async () => {
    const io = recordingIo();
    const close = vi.fn(async () => undefined);
    await expect(
      suppressionRemoveCommand(io, {
        installationId: 1n,
        repo: 'org/repo',
        ruleId: 1n,
        env: { DATABASE_URL: 'postgres://x' } as NodeJS.ProcessEnv,
        createDb: () => ({ db: fakeDb, close }),
        deleteRule: async () => {
          throw new Error('DB down');
        },
      }),
    ).rejects.toThrow(/DB down/);
    expect(close).toHaveBeenCalledOnce();
  });
});
