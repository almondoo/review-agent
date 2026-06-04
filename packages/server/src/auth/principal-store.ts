/**
 * Principal store — read-only queries against operatorPrincipals and
 * installationMemberships tables.
 *
 * These tables have NO RLS (intentional; they are the auth control-plane and
 * must be readable before any tenant GUC is set). Do NOT use withTenant here.
 *
 * Only read operations are implemented in this phase. Write operations
 * (createPrincipal, setPassword, grantMembership) are reserved for the CLI
 * phase and are not included here.
 *
 * Signature for future write operations (CLI phase):
 *   createPrincipal(db, opts: {id: string; username: string; passwordHash: string}): Promise<void>
 *   setTokenVersion(db, principalId: string, version: number): Promise<void>
 *   upsertMembership(db, principalId: string, installationId: string, role: DashboardRole): Promise<void>
 */
import { type DashboardRole, dashboardRoleSchema } from '@review-agent/core';
import { installationMemberships, operatorPrincipals } from '@review-agent/core/db';
import type { DbClient } from '@review-agent/db';
import { eq } from 'drizzle-orm';

/** Shape returned for membership entries. installationId is string (bigint → string). */
export type MembershipEntry = {
  readonly installationId: string;
  readonly role: DashboardRole;
};

/** Shape returned for principal lookups. */
export type PrincipalRecord = {
  readonly id: string;
  readonly username: string;
  readonly passwordHash: string;
  readonly tokenVersion: number;
};

/**
 * Find a principal by username.
 * Returns null when no principal with that username exists.
 */
export async function findPrincipalByUsername(
  db: DbClient,
  username: string,
): Promise<PrincipalRecord | null> {
  const rows = await db
    .select({
      id: operatorPrincipals.id,
      username: operatorPrincipals.username,
      passwordHash: operatorPrincipals.passwordHash,
      tokenVersion: operatorPrincipals.tokenVersion,
    })
    .from(operatorPrincipals)
    .where(eq(operatorPrincipals.username, username))
    .limit(1);

  const row = rows[0];
  return row !== undefined ? row : null;
}

/**
 * Find a principal by id.
 * Returns null when no principal with that id exists.
 */
export async function findPrincipalById(db: DbClient, id: string): Promise<PrincipalRecord | null> {
  const rows = await db
    .select({
      id: operatorPrincipals.id,
      username: operatorPrincipals.username,
      passwordHash: operatorPrincipals.passwordHash,
      tokenVersion: operatorPrincipals.tokenVersion,
    })
    .from(operatorPrincipals)
    .where(eq(operatorPrincipals.id, id))
    .limit(1);

  const row = rows[0];
  return row !== undefined ? row : null;
}

/**
 * Get all installation memberships for a principal.
 *
 * installationId is returned as a string (bigint → string conversion).
 * Rows with an unrecognised role value are excluded (with a warning logged)
 * rather than silently defaulted — this surfaces data integrity issues early.
 */
export async function getMembershipsByPrincipal(
  db: DbClient,
  principalId: string,
): Promise<MembershipEntry[]> {
  const rows = await db
    .select({
      installationId: installationMemberships.installationId,
      role: installationMemberships.role,
    })
    .from(installationMemberships)
    .where(eq(installationMemberships.principalId, principalId));

  const result: MembershipEntry[] = [];
  for (const row of rows) {
    const parsed = dashboardRoleSchema.safeParse(row.role);
    if (!parsed.success) {
      process.stderr.write(
        `[review-agent] WARN: principal ${principalId} has unrecognised role "${row.role}" for installation ${String(row.installationId)} — skipping\n`,
      );
      continue;
    }
    result.push({
      installationId: String(row.installationId),
      role: parsed.data,
    });
  }
  return result;
}

/**
 * Get the membership for a specific principal + installation combination.
 * Returns null when no membership row exists (used to deny access for
 * principals that have no access to that installation) or when the
 * installationId string is not a valid integer.
 */
export async function getMembership(
  db: DbClient,
  principalId: string,
  installationId: string,
): Promise<{ readonly role: DashboardRole } | null> {
  // Reject non-numeric installationId strings early.
  if (!/^\d+$/.test(installationId)) {
    return null;
  }

  // Load all memberships for this principal and filter in-memory by
  // installationId string comparison. This avoids Drizzle bigint-cast
  // complexity and is fine since membership counts per principal are small.
  const rows = await db
    .select({
      installationId: installationMemberships.installationId,
      role: installationMemberships.role,
    })
    .from(installationMemberships)
    .where(eq(installationMemberships.principalId, principalId))
    .limit(200);

  for (const row of rows) {
    if (String(row.installationId) === installationId) {
      const parsed = dashboardRoleSchema.safeParse(row.role);
      if (!parsed.success) {
        process.stderr.write(
          `[review-agent] WARN: principal ${principalId} has unrecognised role "${row.role}" for installation ${installationId} — treating as no membership\n`,
        );
        return null;
      }
      return { role: parsed.data };
    }
  }
  return null;
}
