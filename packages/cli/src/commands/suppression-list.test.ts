import type { DbClient } from '@review-agent/db';
import { describe, expect, it } from 'vitest';
import { suppressionListCommand } from './suppression-list.js';

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

const now = new Date('2026-06-01T00:00:00Z');
const expires = new Date('2026-11-28T00:00:00Z');

describe('suppressionListCommand', () => {
  it('returns config_error when DATABASE_URL is missing', async () => {
    const io = recordingIo();
    const result = await suppressionListCommand(io, {
      installationId: 1n,
      repo: 'org/repo',
      env: {} as NodeJS.ProcessEnv,
    });
    expect(result.status).toBe('config_error');
    expect(io.err.join('')).toContain('DATABASE_URL');
  });

  it('accepts REVIEW_AGENT_DATABASE_URL as a fallback', async () => {
    const io = recordingIo();
    const result = await suppressionListCommand(io, {
      installationId: 1n,
      repo: 'org/repo',
      env: { REVIEW_AGENT_DATABASE_URL: 'postgres://x' } as NodeJS.ProcessEnv,
      createDb: fakeCreateDb,
      loadSuppressions: async () => [],
    });
    expect(result.status).toBe('ok');
  });

  it('prints a "no rules" message when the list is empty', async () => {
    const io = recordingIo();
    const result = await suppressionListCommand(io, {
      installationId: 1n,
      repo: 'org/repo',
      env: { DATABASE_URL: 'postgres://x' } as NodeJS.ProcessEnv,
      createDb: fakeCreateDb,
      loadSuppressions: async () => [],
    });
    expect(result.status).toBe('ok');
    expect(result.count).toBe(0);
    expect(io.out.join('')).toContain('No active suppression rules');
  });

  it('lists active suppression rules with ID, fingerprint, and dates', async () => {
    const io = recordingIo();
    const result = await suppressionListCommand(io, {
      installationId: 1n,
      repo: 'org/repo',
      env: { DATABASE_URL: 'postgres://x' } as NodeJS.ProcessEnv,
      createDb: fakeCreateDb,
      now,
      loadSuppressions: async () => [
        {
          id: 42n,
          factText: '[fp:abc123def456] Auto-suppressed after 3 rejection(s)',
          createdAt: now,
          expiresAt: expires,
        },
        {
          id: 43n,
          factText: '[fp:deadbeef0000] Auto-suppressed after 3 rejection(s)',
          createdAt: now,
          expiresAt: expires,
        },
      ],
    });
    expect(result.status).toBe('ok');
    expect(result.count).toBe(2);
    const output = io.out.join('');
    expect(output).toContain('ID 42');
    expect(output).toContain('abc123def456');
    expect(output).toContain('ID 43');
    expect(output).toContain('deadbeef0000');
    expect(output).toContain('suppression remove');
  });

  it('formats the count label correctly for a single rule', async () => {
    const io = recordingIo();
    await suppressionListCommand(io, {
      installationId: 1n,
      repo: 'org/repo',
      env: { DATABASE_URL: 'postgres://x' } as NodeJS.ProcessEnv,
      createDb: fakeCreateDb,
      loadSuppressions: async () => [
        { id: 1n, factText: '[fp:aaa] reason', createdAt: now, expiresAt: expires },
      ],
    });
    const output = io.out.join('');
    // Singular "rule" for count=1
    expect(output).toContain('1 rule)');
  });

  it('handles a suppression rule with malformed factText gracefully', async () => {
    const io = recordingIo();
    const result = await suppressionListCommand(io, {
      installationId: 1n,
      repo: 'org/repo',
      env: { DATABASE_URL: 'postgres://x' } as NodeJS.ProcessEnv,
      createDb: fakeCreateDb,
      loadSuppressions: async () => [
        { id: 1n, factText: 'malformed without fp prefix', createdAt: now, expiresAt: expires },
      ],
    });
    expect(result.status).toBe('ok');
    // Falls back to '(unknown)' for the fingerprint.
    expect(io.out.join('')).toContain('(unknown)');
  });
});
