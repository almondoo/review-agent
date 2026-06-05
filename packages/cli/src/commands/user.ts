import { randomBytes, randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { type DashboardRole, dashboardRoleSchema, hashPassword } from '@review-agent/core';
import {
  type AuditAppender,
  createAuditAppender,
  createDbClient,
  createPrincipal,
  type DbClient,
  deletePrincipal,
  getPrincipalByUsername,
  listMemberships,
  listPrincipals,
  revokeMembership,
  setPrincipalPassword,
  upsertMembership,
  withTenant,
} from '@review-agent/db';
import type { ProgramIo } from '../io.js';

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/** Returns true when the value is a non-empty string of digits. */
function isValidInstallationId(value: string): boolean {
  return /^\d+$/.test(value);
}

// ---------------------------------------------------------------------------
// Password utilities
// ---------------------------------------------------------------------------

/**
 * Generate a cryptographically strong random password string (24 url-safe
 * Base64 characters from 18 random bytes → ~107 bits of entropy).
 * The plain text is returned ONCE to the caller; it is never stored.
 */
function generatePassword(): string {
  return randomBytes(18).toString('base64url');
}

/**
 * Read a password interactively from stdin with echo suppressed.
 *
 * Falls back gracefully when stdin is not a TTY: reads a single line of
 * plain text. Callers should document this behaviour to operators.
 */
async function readPasswordInteractive(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });

    // Suppress echo only when running in a real terminal.
    /* v8 ignore start */
    if (process.stdin.isTTY) {
      process.stdout.write(prompt);
      process.stdin.setRawMode(true);
      let password = '';
      process.stdin.resume();
      process.stdin.setEncoding('utf8');

      const onData = (char: string) => {
        if (char === '\r' || char === '\n') {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.removeListener('data', onData);
          process.stdout.write('\n');
          rl.close();
          resolve(password);
        } else if (char === '') {
          // Ctrl+C
          process.stdin.setRawMode(false);
          process.stdout.write('\n');
          rl.close();
          process.exit(1);
        } else if (char === '' || char === '\b') {
          // backspace
          if (password.length > 0) {
            password = password.slice(0, -1);
          }
        } else {
          password += char;
        }
      };
      process.stdin.on('data', onData);
    } else {
      // Non-TTY fallback: readline reads a plain line.
      rl.question(prompt, (answer) => {
        rl.close();
        resolve(answer);
      });
    }
    /* v8 ignore stop */
  });
}

// ---------------------------------------------------------------------------
// Shared DB-connection helper (same pattern as audit-export / suppression)
// ---------------------------------------------------------------------------

function resolveDbUrl(env: NodeJS.ProcessEnv): string | undefined {
  return env.DATABASE_URL ?? env.REVIEW_AGENT_DATABASE_URL;
}

// ---------------------------------------------------------------------------
// user create
// ---------------------------------------------------------------------------

export type UserCreateOpts = {
  readonly username: string;
  readonly role?: DashboardRole;
  readonly installation?: string;
  readonly password?: string;
  readonly generate?: boolean;
  readonly env: NodeJS.ProcessEnv;
  // Test seams.
  readonly createDb?: (url: string) => { db: DbClient; close: () => Promise<void> };
  readonly createPrincipalFn?: typeof createPrincipal;
  readonly upsertMembershipFn?: typeof upsertMembership;
  /** Override password-prompt / generation for tests. */
  readonly resolvePassword?: (opts: UserCreateOpts) => Promise<string>;
  /** Test seam: override the AuditAppender used for writing audit events. */
  readonly auditAppenderFn?: (db: DbClient) => AuditAppender;
};

export type UserCreateResult = {
  readonly status: 'ok' | 'config_error' | 'validation_error' | 'already_exists';
  readonly id?: string;
};

export async function userCreateCommand(
  io: ProgramIo,
  opts: UserCreateOpts,
): Promise<UserCreateResult> {
  // --- Validate input ---
  if (!opts.username.trim()) {
    io.stderr('--username must not be empty.\n');
    return { status: 'validation_error' };
  }
  const roleResult =
    opts.role !== undefined ? dashboardRoleSchema.safeParse(opts.role) : { success: true as const };
  if (!roleResult.success) {
    io.stderr(`--role must be one of viewer, editor, admin.\n`);
    return { status: 'validation_error' };
  }
  if (opts.installation !== undefined && !isValidInstallationId(opts.installation)) {
    io.stderr('--installation must be a positive integer string.\n');
    return { status: 'validation_error' };
  }

  // --- Resolve DATABASE_URL ---
  const url = resolveDbUrl(opts.env);
  if (!url && !opts.createDb) {
    io.stderr('DATABASE_URL (or REVIEW_AGENT_DATABASE_URL) is required.\n');
    return { status: 'config_error' };
  }

  // --- Resolve plain-text password (never stored) ---
  let plain: string;
  if (opts.resolvePassword) {
    plain = await opts.resolvePassword(opts);
  } else if (opts.generate) {
    plain = generatePassword();
    io.stdout(`Generated password (shown once — store it now): ${plain}\n`);
  } else if (opts.password) {
    plain = opts.password;
  } else {
    plain = await readPasswordInteractive('Password: ');
  }
  if (!plain) {
    io.stderr('Password must not be empty.\n');
    return { status: 'validation_error' };
  }

  const passwordHash = hashPassword(plain);
  // Discard plain-text immediately — never pass it further.
  const id = randomUUID();

  /* v8 ignore next */
  const makeDb = opts.createDb ?? ((u: string) => createDbClient({ url: u }));
  const { db, close } = makeDb(url ?? '');
  /* v8 ignore next */
  const create = opts.createPrincipalFn ?? createPrincipal;
  /* v8 ignore next */
  const upsert = opts.upsertMembershipFn ?? upsertMembership;
  /* v8 ignore next */
  const makeAuditAppender = opts.auditAppenderFn ?? createAuditAppender;
  const appender = makeAuditAppender(db);
  const cliActor = `cli:${opts.env.USER ?? 'unknown'}`;

  try {
    try {
      await create(db, { id, username: opts.username, passwordHash });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('already taken')) {
        io.stderr(`${msg}\n`);
        return { status: 'already_exists' };
      }
      throw err;
    }

    io.stdout(`Created principal '${opts.username}' (id: ${id}).\n`);

    // Audit principal.create. principal events have no installation_id
    // (global scope). The audit_log RLS withCheck allows NULL installation_id,
    // but the `using` clause requires app.current_tenant to match — in a plain
    // CLI connection the GUC is unset, so the SELECT for prev_hash will return
    // no rows (defaulting to genesis). Each global CLI event starts an isolated
    // chain segment; this is a known limitation documented in docs/security/audit-log.md.
    try {
      await appender({
        event: 'principal.create',
        resourceType: 'principal',
        resourceId: id,
        actor: cliActor,
        ...(opts.installation !== undefined ? { installationId: BigInt(opts.installation) } : {}),
      });
    } catch (auditErr) {
      process.stderr.write(
        `[review-agent] WARN: audit write failed for principal.create id=${id}: ${String(auditErr)}\n`,
      );
    }

    if (opts.installation !== undefined) {
      const role: DashboardRole = opts.role ?? 'viewer';
      await upsert(db, id, opts.installation, role);
      io.stdout(`Granted role '${role}' on installation ${opts.installation}.\n`);

      // Audit membership.grant under the installation's tenant context.
      try {
        await withTenant(db, BigInt(opts.installation), async () => {
          await appender({
            event: 'membership.grant',
            installationId: BigInt(opts.installation ?? '0'),
            resourceType: 'membership',
            resourceId: `${id}:${opts.installation}`,
            actor: cliActor,
          });
        });
      } catch (auditErr) {
        process.stderr.write(
          `[review-agent] WARN: audit write failed for membership.grant: ${String(auditErr)}\n`,
        );
      }
    }

    return { status: 'ok', id };
  } finally {
    await close();
  }
}

// ---------------------------------------------------------------------------
// user list
// ---------------------------------------------------------------------------

export type UserListOpts = {
  readonly env: NodeJS.ProcessEnv;
  // Test seams.
  readonly createDb?: (url: string) => { db: DbClient; close: () => Promise<void> };
  readonly listPrincipalsFn?: typeof listPrincipals;
  readonly listMembershipsFn?: typeof listMemberships;
};

export type UserListResult = {
  readonly status: 'ok' | 'config_error';
  readonly count: number;
};

export async function userListCommand(io: ProgramIo, opts: UserListOpts): Promise<UserListResult> {
  const url = resolveDbUrl(opts.env);
  if (!url && !opts.createDb) {
    io.stderr('DATABASE_URL (or REVIEW_AGENT_DATABASE_URL) is required.\n');
    return { status: 'config_error', count: 0 };
  }

  /* v8 ignore next */
  const makeDb = opts.createDb ?? ((u: string) => createDbClient({ url: u }));
  const { db, close } = makeDb(url ?? '');
  /* v8 ignore next */
  const listP = opts.listPrincipalsFn ?? listPrincipals;
  /* v8 ignore next */
  const listM = opts.listMembershipsFn ?? listMemberships;

  try {
    const principals = await listP(db);

    if (principals.length === 0) {
      io.stdout('No principals found.\n');
      return { status: 'ok', count: 0 };
    }

    for (const p of principals) {
      io.stdout(`\n  Username:       ${p.username}\n`);
      io.stdout(`  ID:             ${p.id}\n`);
      io.stdout(`  Provider:       ${p.provider}\n`);
      io.stdout(`  Token version:  ${p.tokenVersion}\n`);
      io.stdout(`  Created:        ${p.createdAt.toISOString()}\n`);

      const memberships = await listM(db, p.id);
      if (memberships.length === 0) {
        io.stdout(`  Memberships:    (none)\n`);
      } else {
        for (const m of memberships) {
          io.stdout(`  Membership:     installation=${m.installationId}  role=${m.role}\n`);
        }
      }
    }
    io.stdout('\n');
    return { status: 'ok', count: principals.length };
  } finally {
    await close();
  }
}

// ---------------------------------------------------------------------------
// user set-password
// ---------------------------------------------------------------------------

export type UserSetPasswordOpts = {
  readonly username: string;
  readonly password?: string;
  readonly generate?: boolean;
  readonly env: NodeJS.ProcessEnv;
  // Test seams.
  readonly createDb?: (url: string) => { db: DbClient; close: () => Promise<void> };
  readonly getPrincipalFn?: typeof getPrincipalByUsername;
  readonly setPrincipalPasswordFn?: typeof setPrincipalPassword;
  /** Override password-prompt / generation for tests. */
  readonly resolvePassword?: (opts: UserSetPasswordOpts) => Promise<string>;
  /** Test seam: override the AuditAppender used for writing audit events. */
  readonly auditAppenderFn?: (db: DbClient) => AuditAppender;
};

export type UserSetPasswordResult = {
  readonly status: 'ok' | 'config_error' | 'not_found' | 'validation_error';
};

export async function userSetPasswordCommand(
  io: ProgramIo,
  opts: UserSetPasswordOpts,
): Promise<UserSetPasswordResult> {
  const url = resolveDbUrl(opts.env);
  if (!url && !opts.createDb) {
    io.stderr('DATABASE_URL (or REVIEW_AGENT_DATABASE_URL) is required.\n');
    return { status: 'config_error' };
  }

  // --- Resolve password ---
  let plain: string;
  if (opts.resolvePassword) {
    plain = await opts.resolvePassword(opts);
  } else if (opts.generate) {
    plain = generatePassword();
    io.stdout(`Generated password (shown once — store it now): ${plain}\n`);
  } else if (opts.password) {
    plain = opts.password;
  } else {
    plain = await readPasswordInteractive('New password: ');
  }
  if (!plain) {
    io.stderr('Password must not be empty.\n');
    return { status: 'validation_error' };
  }

  const passwordHash = hashPassword(plain);

  /* v8 ignore next */
  const makeDb = opts.createDb ?? ((u: string) => createDbClient({ url: u }));
  const { db, close } = makeDb(url ?? '');
  /* v8 ignore next */
  const getPrincipal = opts.getPrincipalFn ?? getPrincipalByUsername;
  /* v8 ignore next */
  const setPassword = opts.setPrincipalPasswordFn ?? setPrincipalPassword;
  /* v8 ignore next */
  const makeAuditAppender = opts.auditAppenderFn ?? createAuditAppender;
  const appender = makeAuditAppender(db);
  const cliActor = `cli:${opts.env.USER ?? 'unknown'}`;

  try {
    const principal = await getPrincipal(db, opts.username);
    if (!principal) {
      io.stderr(`Principal '${opts.username}' not found.\n`);
      return { status: 'not_found' };
    }

    await setPassword(db, principal.id, passwordHash);
    io.stdout(
      `Password updated for '${opts.username}'. ` +
        'All existing sessions have been invalidated (token version bumped).\n',
    );

    // Audit principal.password_change (best-effort; global/null-installation event).
    try {
      await appender({
        event: 'principal.password_change',
        resourceType: 'principal',
        resourceId: principal.id,
        actor: cliActor,
      });
    } catch (auditErr) {
      process.stderr.write(
        `[review-agent] WARN: audit write failed for principal.password_change id=${principal.id}: ${String(auditErr)}\n`,
      );
    }

    return { status: 'ok' };
  } finally {
    await close();
  }
}

// ---------------------------------------------------------------------------
// user delete
// ---------------------------------------------------------------------------

export type UserDeleteOpts = {
  readonly username: string;
  readonly env: NodeJS.ProcessEnv;
  // Test seams.
  readonly createDb?: (url: string) => { db: DbClient; close: () => Promise<void> };
  readonly getPrincipalFn?: typeof getPrincipalByUsername;
  readonly deletePrincipalFn?: typeof deletePrincipal;
  /** Test seam: override the AuditAppender used for writing audit events. */
  readonly auditAppenderFn?: (db: DbClient) => AuditAppender;
};

export type UserDeleteResult = {
  readonly status: 'ok' | 'config_error' | 'not_found';
};

export async function userDeleteCommand(
  io: ProgramIo,
  opts: UserDeleteOpts,
): Promise<UserDeleteResult> {
  const url = resolveDbUrl(opts.env);
  if (!url && !opts.createDb) {
    io.stderr('DATABASE_URL (or REVIEW_AGENT_DATABASE_URL) is required.\n');
    return { status: 'config_error' };
  }

  /* v8 ignore next */
  const makeDb = opts.createDb ?? ((u: string) => createDbClient({ url: u }));
  const { db, close } = makeDb(url ?? '');
  /* v8 ignore next */
  const getPrincipal = opts.getPrincipalFn ?? getPrincipalByUsername;
  /* v8 ignore next */
  const del = opts.deletePrincipalFn ?? deletePrincipal;
  /* v8 ignore next */
  const makeAuditAppender = opts.auditAppenderFn ?? createAuditAppender;
  const appender = makeAuditAppender(db);
  const cliActor = `cli:${opts.env.USER ?? 'unknown'}`;

  try {
    const principal = await getPrincipal(db, opts.username);
    if (!principal) {
      io.stderr(`Principal '${opts.username}' not found.\n`);
      return { status: 'not_found' };
    }

    // Audit principal.delete before deleting (so we have the id).
    try {
      await appender({
        event: 'principal.delete',
        resourceType: 'principal',
        resourceId: principal.id,
        actor: cliActor,
      });
    } catch (auditErr) {
      process.stderr.write(
        `[review-agent] WARN: audit write failed for principal.delete id=${principal.id}: ${String(auditErr)}\n`,
      );
    }

    await del(db, principal.id);
    io.stdout(`Deleted principal '${opts.username}'.\n`);
    return { status: 'ok' };
  } finally {
    await close();
  }
}

// ---------------------------------------------------------------------------
// user grant
// ---------------------------------------------------------------------------

export type UserGrantOpts = {
  readonly username: string;
  readonly installation: string;
  readonly role: DashboardRole;
  readonly env: NodeJS.ProcessEnv;
  // Test seams.
  readonly createDb?: (url: string) => { db: DbClient; close: () => Promise<void> };
  readonly getPrincipalFn?: typeof getPrincipalByUsername;
  readonly upsertMembershipFn?: typeof upsertMembership;
  /** Test seam: override the AuditAppender used for writing audit events. */
  readonly auditAppenderFn?: (db: DbClient) => AuditAppender;
};

export type UserGrantResult = {
  readonly status: 'ok' | 'config_error' | 'not_found' | 'validation_error';
};

export async function userGrantCommand(
  io: ProgramIo,
  opts: UserGrantOpts,
): Promise<UserGrantResult> {
  const roleResult = dashboardRoleSchema.safeParse(opts.role);
  if (!roleResult.success) {
    io.stderr('--role must be one of viewer, editor, admin.\n');
    return { status: 'validation_error' };
  }
  if (!isValidInstallationId(opts.installation)) {
    io.stderr('--installation must be a positive integer string.\n');
    return { status: 'validation_error' };
  }

  const url = resolveDbUrl(opts.env);
  if (!url && !opts.createDb) {
    io.stderr('DATABASE_URL (or REVIEW_AGENT_DATABASE_URL) is required.\n');
    return { status: 'config_error' };
  }

  /* v8 ignore next */
  const makeDb = opts.createDb ?? ((u: string) => createDbClient({ url: u }));
  const { db, close } = makeDb(url ?? '');
  /* v8 ignore next */
  const getPrincipal = opts.getPrincipalFn ?? getPrincipalByUsername;
  /* v8 ignore next */
  const upsert = opts.upsertMembershipFn ?? upsertMembership;
  /* v8 ignore next */
  const makeAuditAppender = opts.auditAppenderFn ?? createAuditAppender;
  const appender = makeAuditAppender(db);
  const cliActor = `cli:${opts.env.USER ?? 'unknown'}`;

  try {
    const principal = await getPrincipal(db, opts.username);
    if (!principal) {
      io.stderr(`Principal '${opts.username}' not found.\n`);
      return { status: 'not_found' };
    }

    await upsert(db, principal.id, opts.installation, opts.role);
    io.stdout(
      `Granted role '${opts.role}' to '${opts.username}' on installation ${opts.installation}.\n`,
    );

    // Audit membership.grant under the installation's tenant context.
    try {
      await withTenant(db, BigInt(opts.installation), async () => {
        await appender({
          event: 'membership.grant',
          installationId: BigInt(opts.installation),
          resourceType: 'membership',
          resourceId: `${principal.id}:${opts.installation}`,
          actor: cliActor,
        });
      });
    } catch (auditErr) {
      process.stderr.write(
        `[review-agent] WARN: audit write failed for membership.grant: ${String(auditErr)}\n`,
      );
    }

    return { status: 'ok' };
  } finally {
    await close();
  }
}

// ---------------------------------------------------------------------------
// user revoke
// ---------------------------------------------------------------------------

export type UserRevokeOpts = {
  readonly username: string;
  readonly installation: string;
  readonly env: NodeJS.ProcessEnv;
  // Test seams.
  readonly createDb?: (url: string) => { db: DbClient; close: () => Promise<void> };
  readonly getPrincipalFn?: typeof getPrincipalByUsername;
  readonly revokeMembershipFn?: typeof revokeMembership;
  /** Test seam: override the AuditAppender used for writing audit events. */
  readonly auditAppenderFn?: (db: DbClient) => AuditAppender;
};

export type UserRevokeResult = {
  readonly status: 'ok' | 'config_error' | 'not_found' | 'validation_error';
};

export async function userRevokeCommand(
  io: ProgramIo,
  opts: UserRevokeOpts,
): Promise<UserRevokeResult> {
  if (!isValidInstallationId(opts.installation)) {
    io.stderr('--installation must be a positive integer string.\n');
    return { status: 'validation_error' };
  }

  const url = resolveDbUrl(opts.env);
  if (!url && !opts.createDb) {
    io.stderr('DATABASE_URL (or REVIEW_AGENT_DATABASE_URL) is required.\n');
    return { status: 'config_error' };
  }

  /* v8 ignore next */
  const makeDb = opts.createDb ?? ((u: string) => createDbClient({ url: u }));
  const { db, close } = makeDb(url ?? '');
  /* v8 ignore next */
  const getPrincipal = opts.getPrincipalFn ?? getPrincipalByUsername;
  /* v8 ignore next */
  const revoke = opts.revokeMembershipFn ?? revokeMembership;
  /* v8 ignore next */
  const makeAuditAppender = opts.auditAppenderFn ?? createAuditAppender;
  const appender = makeAuditAppender(db);
  const cliActor = `cli:${opts.env.USER ?? 'unknown'}`;

  try {
    const principal = await getPrincipal(db, opts.username);
    if (!principal) {
      io.stderr(`Principal '${opts.username}' not found.\n`);
      return { status: 'not_found' };
    }

    await revoke(db, principal.id, opts.installation);
    io.stdout(`Revoked membership for '${opts.username}' on installation ${opts.installation}.\n`);

    // Audit membership.revoke under the installation's tenant context.
    try {
      await withTenant(db, BigInt(opts.installation), async () => {
        await appender({
          event: 'membership.revoke',
          installationId: BigInt(opts.installation),
          resourceType: 'membership',
          resourceId: `${principal.id}:${opts.installation}`,
          actor: cliActor,
        });
      });
    } catch (auditErr) {
      process.stderr.write(
        `[review-agent] WARN: audit write failed for membership.revoke: ${String(auditErr)}\n`,
      );
    }

    return { status: 'ok' };
  } finally {
    await close();
  }
}
