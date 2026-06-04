import type { DbClient } from '@review-agent/db';
import { describe, expect, it, vi } from 'vitest';
import {
  userCreateCommand,
  userDeleteCommand,
  userGrantCommand,
  userListCommand,
  userRevokeCommand,
  userSetPasswordCommand,
} from './user.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

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

const NOW = new Date('2026-06-01T00:00:00Z');

// ---------------------------------------------------------------------------
// userCreateCommand
// ---------------------------------------------------------------------------

describe('userCreateCommand', () => {
  it('returns config_error when DATABASE_URL is missing', async () => {
    const io = recordingIo();
    const result = await userCreateCommand(io, {
      username: 'alice',
      env: {} as NodeJS.ProcessEnv,
    });
    expect(result.status).toBe('config_error');
    expect(io.err.join('')).toContain('DATABASE_URL');
  });

  it('returns validation_error for empty username', async () => {
    const io = recordingIo();
    const result = await userCreateCommand(io, {
      username: '  ',
      env: { DATABASE_URL: 'postgres://x' } as NodeJS.ProcessEnv,
      createDb: fakeCreateDb,
      resolvePassword: async () => 'secret',
    });
    expect(result.status).toBe('validation_error');
    expect(io.err.join('')).toContain('--username');
  });

  it('returns validation_error for invalid role', async () => {
    const io = recordingIo();
    const result = await userCreateCommand(io, {
      username: 'alice',
      role: 'superuser' as never,
      env: { DATABASE_URL: 'postgres://x' } as NodeJS.ProcessEnv,
      createDb: fakeCreateDb,
      resolvePassword: async () => 'secret',
    });
    expect(result.status).toBe('validation_error');
    expect(io.err.join('')).toContain('--role');
  });

  it('returns validation_error for non-numeric installation ID', async () => {
    const io = recordingIo();
    const result = await userCreateCommand(io, {
      username: 'alice',
      installation: 'abc',
      env: { DATABASE_URL: 'postgres://x' } as NodeJS.ProcessEnv,
      createDb: fakeCreateDb,
      resolvePassword: async () => 'secret',
    });
    expect(result.status).toBe('validation_error');
    expect(io.err.join('')).toContain('--installation');
  });

  it('creates a principal without membership when no --installation', async () => {
    const io = recordingIo();
    const createPrincipalFn = vi.fn().mockResolvedValue(undefined);
    const result = await userCreateCommand(io, {
      username: 'alice',
      env: { DATABASE_URL: 'postgres://x' } as NodeJS.ProcessEnv,
      createDb: fakeCreateDb,
      createPrincipalFn,
      resolvePassword: async () => 'secret123',
    });
    expect(result.status).toBe('ok');
    expect(result.id).toBeTruthy();
    expect(createPrincipalFn).toHaveBeenCalledOnce();
    const arg = createPrincipalFn.mock.calls[0]?.[1];
    // Password is hashed — must NOT equal the plain text
    expect(arg?.passwordHash).not.toBe('secret123');
    expect(arg?.passwordHash).toMatch(/^scrypt\$/);
    expect(arg?.username).toBe('alice');
    expect(io.out.join('')).toContain("Created principal 'alice'");
  });

  it('creates a principal AND membership when --installation is provided', async () => {
    const io = recordingIo();
    const createPrincipalFn = vi.fn().mockResolvedValue(undefined);
    const upsertMembershipFn = vi.fn().mockResolvedValue(undefined);
    const result = await userCreateCommand(io, {
      username: 'alice',
      installation: '12345',
      role: 'editor',
      env: { DATABASE_URL: 'postgres://x' } as NodeJS.ProcessEnv,
      createDb: fakeCreateDb,
      createPrincipalFn,
      upsertMembershipFn,
      resolvePassword: async () => 'secret123',
    });
    expect(result.status).toBe('ok');
    expect(upsertMembershipFn).toHaveBeenCalledOnce();
    const [, , instId, role] = upsertMembershipFn.mock.calls[0] as [
      DbClient,
      string,
      string,
      string,
    ];
    expect(instId).toBe('12345');
    expect(role).toBe('editor');
    expect(io.out.join('')).toContain("Granted role 'editor' on installation 12345");
  });

  it('defaults membership role to viewer when --installation is set but --role omitted', async () => {
    const io = recordingIo();
    const createPrincipalFn = vi.fn().mockResolvedValue(undefined);
    const upsertMembershipFn = vi.fn().mockResolvedValue(undefined);
    await userCreateCommand(io, {
      username: 'alice',
      installation: '99',
      env: { DATABASE_URL: 'postgres://x' } as NodeJS.ProcessEnv,
      createDb: fakeCreateDb,
      createPrincipalFn,
      upsertMembershipFn,
      resolvePassword: async () => 'pw',
    });
    const [, , , role] = upsertMembershipFn.mock.calls[0] as [DbClient, string, string, string];
    expect(role).toBe('viewer');
  });

  it('returns already_exists when createPrincipal throws "already taken"', async () => {
    const io = recordingIo();
    const createPrincipalFn = vi
      .fn()
      .mockRejectedValue(new Error("Username 'alice' is already taken."));
    const result = await userCreateCommand(io, {
      username: 'alice',
      env: { DATABASE_URL: 'postgres://x' } as NodeJS.ProcessEnv,
      createDb: fakeCreateDb,
      createPrincipalFn,
      resolvePassword: async () => 'pw',
    });
    expect(result.status).toBe('already_exists');
    expect(io.err.join('')).toContain('already taken');
  });

  it('rethrows unexpected DB errors', async () => {
    const io = recordingIo();
    const createPrincipalFn = vi.fn().mockRejectedValue(new Error('network error'));
    await expect(
      userCreateCommand(io, {
        username: 'alice',
        env: { DATABASE_URL: 'postgres://x' } as NodeJS.ProcessEnv,
        createDb: fakeCreateDb,
        createPrincipalFn,
        resolvePassword: async () => 'pw',
      }),
    ).rejects.toThrow('network error');
  });

  it('closes the DB even on failure', async () => {
    const io = recordingIo();
    const close = vi.fn().mockResolvedValue(undefined);
    const createPrincipalFn = vi.fn().mockRejectedValue(new Error('boom'));
    await expect(
      userCreateCommand(io, {
        username: 'alice',
        env: { DATABASE_URL: 'postgres://x' } as NodeJS.ProcessEnv,
        createDb: () => ({ db: fakeDb, close }),
        createPrincipalFn,
        resolvePassword: async () => 'pw',
      }),
    ).rejects.toThrow('boom');
    expect(close).toHaveBeenCalledOnce();
  });

  it('accepts REVIEW_AGENT_DATABASE_URL as a fallback', async () => {
    const io = recordingIo();
    const createPrincipalFn = vi.fn().mockResolvedValue(undefined);
    const result = await userCreateCommand(io, {
      username: 'bob',
      env: { REVIEW_AGENT_DATABASE_URL: 'postgres://x' } as NodeJS.ProcessEnv,
      createDb: fakeCreateDb,
      createPrincipalFn,
      resolvePassword: async () => 'pw',
    });
    expect(result.status).toBe('ok');
  });

  it('returns validation_error when resolved password is empty', async () => {
    const io = recordingIo();
    const result = await userCreateCommand(io, {
      username: 'alice',
      env: { DATABASE_URL: 'postgres://x' } as NodeJS.ProcessEnv,
      createDb: fakeCreateDb,
      resolvePassword: async () => '',
    });
    expect(result.status).toBe('validation_error');
    expect(io.err.join('')).toContain('empty');
  });

  it('uses --password directly when provided', async () => {
    const io = recordingIo();
    const createPrincipalFn = vi.fn().mockResolvedValue(undefined);
    const result = await userCreateCommand(io, {
      username: 'alice',
      password: 'mypassword',
      env: { DATABASE_URL: 'postgres://x' } as NodeJS.ProcessEnv,
      createDb: fakeCreateDb,
      createPrincipalFn,
    });
    expect(result.status).toBe('ok');
    const arg = createPrincipalFn.mock.calls[0]?.[1];
    expect(arg?.passwordHash).toMatch(/^scrypt\$/);
  });

  it('generates and prints a random password when --generate is true', async () => {
    const io = recordingIo();
    const createPrincipalFn = vi.fn().mockResolvedValue(undefined);
    const result = await userCreateCommand(io, {
      username: 'alice',
      generate: true,
      env: { DATABASE_URL: 'postgres://x' } as NodeJS.ProcessEnv,
      createDb: fakeCreateDb,
      createPrincipalFn,
    });
    expect(result.status).toBe('ok');
    const output = io.out.join('');
    expect(output).toContain('Generated password');
    expect(output).toContain('store it now');
    // The plain-text password appears in the output line
    const match = /Generated password.*: (\S+)/.exec(output);
    expect(match).not.toBeNull();
    expect(match?.[1]?.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// userListCommand
// ---------------------------------------------------------------------------

describe('userListCommand', () => {
  it('returns config_error when DATABASE_URL is missing', async () => {
    const io = recordingIo();
    const result = await userListCommand(io, {
      env: {} as NodeJS.ProcessEnv,
    });
    expect(result.status).toBe('config_error');
    expect(io.err.join('')).toContain('DATABASE_URL');
  });

  it('prints "No principals found" when empty', async () => {
    const io = recordingIo();
    const result = await userListCommand(io, {
      env: { DATABASE_URL: 'postgres://x' } as NodeJS.ProcessEnv,
      createDb: fakeCreateDb,
      listPrincipalsFn: async () => [],
      listMembershipsFn: async () => [],
    });
    expect(result.status).toBe('ok');
    expect(result.count).toBe(0);
    expect(io.out.join('')).toContain('No principals found');
  });

  it('prints principal info with memberships', async () => {
    const io = recordingIo();
    const principals = [
      { id: 'uuid-1', username: 'alice', tokenVersion: 1, createdAt: NOW },
      { id: 'uuid-2', username: 'bob', tokenVersion: 2, createdAt: NOW },
    ];
    const memberships = (id: string) =>
      id === 'uuid-1' ? [{ installationId: '100', role: 'admin' as const }] : [];
    const result = await userListCommand(io, {
      env: { DATABASE_URL: 'postgres://x' } as NodeJS.ProcessEnv,
      createDb: fakeCreateDb,
      listPrincipalsFn: async () => principals,
      listMembershipsFn: async (_, id) => memberships(id),
    });
    expect(result.status).toBe('ok');
    expect(result.count).toBe(2);
    const output = io.out.join('');
    expect(output).toContain('alice');
    expect(output).toContain('installation=100');
    expect(output).toContain('role=admin');
    expect(output).toContain('bob');
    expect(output).toContain('(none)');
  });

  it('closes DB even when listPrincipals throws', async () => {
    const io = recordingIo();
    const close = vi.fn().mockResolvedValue(undefined);
    await expect(
      userListCommand(io, {
        env: { DATABASE_URL: 'postgres://x' } as NodeJS.ProcessEnv,
        createDb: () => ({ db: fakeDb, close }),
        listPrincipalsFn: async () => {
          throw new Error('db gone');
        },
      }),
    ).rejects.toThrow('db gone');
    expect(close).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// userSetPasswordCommand
// ---------------------------------------------------------------------------

describe('userSetPasswordCommand', () => {
  it('returns config_error when DATABASE_URL is missing', async () => {
    const io = recordingIo();
    const result = await userSetPasswordCommand(io, {
      username: 'alice',
      env: {} as NodeJS.ProcessEnv,
      resolvePassword: async () => 'pw',
    });
    expect(result.status).toBe('config_error');
    expect(io.err.join('')).toContain('DATABASE_URL');
  });

  it('returns not_found when the principal does not exist', async () => {
    const io = recordingIo();
    const result = await userSetPasswordCommand(io, {
      username: 'nobody',
      env: { DATABASE_URL: 'postgres://x' } as NodeJS.ProcessEnv,
      createDb: fakeCreateDb,
      getPrincipalFn: async () => null,
      resolvePassword: async () => 'pw',
    });
    expect(result.status).toBe('not_found');
    expect(io.err.join('')).toContain("'nobody' not found");
  });

  it('updates the password and prints session-invalidation notice', async () => {
    const io = recordingIo();
    const setPrincipalPasswordFn = vi.fn().mockResolvedValue(undefined);
    const result = await userSetPasswordCommand(io, {
      username: 'alice',
      env: { DATABASE_URL: 'postgres://x' } as NodeJS.ProcessEnv,
      createDb: fakeCreateDb,
      getPrincipalFn: async () => ({ id: 'uuid-1', username: 'alice', tokenVersion: 1 }),
      setPrincipalPasswordFn,
      resolvePassword: async () => 'newpw',
    });
    expect(result.status).toBe('ok');
    const [, id, hash] = setPrincipalPasswordFn.mock.calls[0] as [DbClient, string, string];
    expect(id).toBe('uuid-1');
    expect(hash).toMatch(/^scrypt\$/);
    // Plain text must NOT appear anywhere in the output
    expect(io.out.join('')).not.toContain('newpw');
    expect(io.out.join('')).toContain('invalidated');
  });

  it('returns validation_error for empty resolved password', async () => {
    const io = recordingIo();
    const result = await userSetPasswordCommand(io, {
      username: 'alice',
      env: { DATABASE_URL: 'postgres://x' } as NodeJS.ProcessEnv,
      createDb: fakeCreateDb,
      resolvePassword: async () => '',
    });
    expect(result.status).toBe('validation_error');
  });

  it('generates and prints a password when --generate is true', async () => {
    const io = recordingIo();
    const setPrincipalPasswordFn = vi.fn().mockResolvedValue(undefined);
    const result = await userSetPasswordCommand(io, {
      username: 'alice',
      generate: true,
      env: { DATABASE_URL: 'postgres://x' } as NodeJS.ProcessEnv,
      createDb: fakeCreateDb,
      getPrincipalFn: async () => ({ id: 'uuid-1', username: 'alice', tokenVersion: 2 }),
      setPrincipalPasswordFn,
    });
    expect(result.status).toBe('ok');
    expect(io.out.join('')).toContain('Generated password');
  });

  it('uses --password directly when provided', async () => {
    const io = recordingIo();
    const setPrincipalPasswordFn = vi.fn().mockResolvedValue(undefined);
    const result = await userSetPasswordCommand(io, {
      username: 'alice',
      password: 'directpw',
      env: { DATABASE_URL: 'postgres://x' } as NodeJS.ProcessEnv,
      createDb: fakeCreateDb,
      getPrincipalFn: async () => ({ id: 'uuid-1', username: 'alice', tokenVersion: 1 }),
      setPrincipalPasswordFn,
    });
    expect(result.status).toBe('ok');
    const [, , hash] = setPrincipalPasswordFn.mock.calls[0] as [DbClient, string, string];
    expect(hash).toMatch(/^scrypt\$/);
  });
});

// ---------------------------------------------------------------------------
// userDeleteCommand
// ---------------------------------------------------------------------------

describe('userDeleteCommand', () => {
  it('returns config_error when DATABASE_URL is missing', async () => {
    const io = recordingIo();
    const result = await userDeleteCommand(io, {
      username: 'alice',
      env: {} as NodeJS.ProcessEnv,
    });
    expect(result.status).toBe('config_error');
  });

  it('returns not_found when the principal does not exist', async () => {
    const io = recordingIo();
    const result = await userDeleteCommand(io, {
      username: 'nobody',
      env: { DATABASE_URL: 'postgres://x' } as NodeJS.ProcessEnv,
      createDb: fakeCreateDb,
      getPrincipalFn: async () => null,
    });
    expect(result.status).toBe('not_found');
    expect(io.err.join('')).toContain("'nobody' not found");
  });

  it('deletes the principal and prints confirmation', async () => {
    const io = recordingIo();
    const deletePrincipalFn = vi.fn().mockResolvedValue(undefined);
    const result = await userDeleteCommand(io, {
      username: 'alice',
      env: { DATABASE_URL: 'postgres://x' } as NodeJS.ProcessEnv,
      createDb: fakeCreateDb,
      getPrincipalFn: async () => ({ id: 'uuid-1', username: 'alice', tokenVersion: 1 }),
      deletePrincipalFn,
    });
    expect(result.status).toBe('ok');
    expect(deletePrincipalFn).toHaveBeenCalledWith(fakeDb, 'uuid-1');
    expect(io.out.join('')).toContain("Deleted principal 'alice'");
  });
});

// ---------------------------------------------------------------------------
// userGrantCommand
// ---------------------------------------------------------------------------

describe('userGrantCommand', () => {
  it('returns config_error when DATABASE_URL is missing', async () => {
    const io = recordingIo();
    const result = await userGrantCommand(io, {
      username: 'alice',
      installation: '1',
      role: 'viewer',
      env: {} as NodeJS.ProcessEnv,
    });
    expect(result.status).toBe('config_error');
  });

  it('returns validation_error for invalid role', async () => {
    const io = recordingIo();
    const result = await userGrantCommand(io, {
      username: 'alice',
      installation: '1',
      role: 'owner' as never,
      env: { DATABASE_URL: 'postgres://x' } as NodeJS.ProcessEnv,
    });
    expect(result.status).toBe('validation_error');
    expect(io.err.join('')).toContain('--role');
  });

  it('returns validation_error for non-numeric installation', async () => {
    const io = recordingIo();
    const result = await userGrantCommand(io, {
      username: 'alice',
      installation: 'abc',
      role: 'viewer',
      env: { DATABASE_URL: 'postgres://x' } as NodeJS.ProcessEnv,
    });
    expect(result.status).toBe('validation_error');
    expect(io.err.join('')).toContain('--installation');
  });

  it('returns not_found when the principal does not exist', async () => {
    const io = recordingIo();
    const result = await userGrantCommand(io, {
      username: 'nobody',
      installation: '1',
      role: 'viewer',
      env: { DATABASE_URL: 'postgres://x' } as NodeJS.ProcessEnv,
      createDb: fakeCreateDb,
      getPrincipalFn: async () => null,
    });
    expect(result.status).toBe('not_found');
  });

  it('upserts the membership and prints confirmation', async () => {
    const io = recordingIo();
    const upsertMembershipFn = vi.fn().mockResolvedValue(undefined);
    const result = await userGrantCommand(io, {
      username: 'alice',
      installation: '42',
      role: 'admin',
      env: { DATABASE_URL: 'postgres://x' } as NodeJS.ProcessEnv,
      createDb: fakeCreateDb,
      getPrincipalFn: async () => ({ id: 'uuid-1', username: 'alice', tokenVersion: 1 }),
      upsertMembershipFn,
    });
    expect(result.status).toBe('ok');
    const [, id, instId, role] = upsertMembershipFn.mock.calls[0] as [
      DbClient,
      string,
      string,
      string,
    ];
    expect(id).toBe('uuid-1');
    expect(instId).toBe('42');
    expect(role).toBe('admin');
    expect(io.out.join('')).toContain("Granted role 'admin' to 'alice' on installation 42");
  });
});

// ---------------------------------------------------------------------------
// userRevokeCommand
// ---------------------------------------------------------------------------

describe('userRevokeCommand', () => {
  it('returns config_error when DATABASE_URL is missing', async () => {
    const io = recordingIo();
    const result = await userRevokeCommand(io, {
      username: 'alice',
      installation: '1',
      env: {} as NodeJS.ProcessEnv,
    });
    expect(result.status).toBe('config_error');
  });

  it('returns validation_error for non-numeric installation', async () => {
    const io = recordingIo();
    const result = await userRevokeCommand(io, {
      username: 'alice',
      installation: 'xyz',
      env: { DATABASE_URL: 'postgres://x' } as NodeJS.ProcessEnv,
    });
    expect(result.status).toBe('validation_error');
    expect(io.err.join('')).toContain('--installation');
  });

  it('returns not_found when the principal does not exist', async () => {
    const io = recordingIo();
    const result = await userRevokeCommand(io, {
      username: 'nobody',
      installation: '1',
      env: { DATABASE_URL: 'postgres://x' } as NodeJS.ProcessEnv,
      createDb: fakeCreateDb,
      getPrincipalFn: async () => null,
    });
    expect(result.status).toBe('not_found');
  });

  it('revokes the membership and prints confirmation', async () => {
    const io = recordingIo();
    const revokeMembershipFn = vi.fn().mockResolvedValue(undefined);
    const result = await userRevokeCommand(io, {
      username: 'alice',
      installation: '55',
      env: { DATABASE_URL: 'postgres://x' } as NodeJS.ProcessEnv,
      createDb: fakeCreateDb,
      getPrincipalFn: async () => ({ id: 'uuid-1', username: 'alice', tokenVersion: 1 }),
      revokeMembershipFn,
    });
    expect(result.status).toBe('ok');
    const [, id, instId] = revokeMembershipFn.mock.calls[0] as [DbClient, string, string];
    expect(id).toBe('uuid-1');
    expect(instId).toBe('55');
    expect(io.out.join('')).toContain("Revoked membership for 'alice' on installation 55");
  });
});
