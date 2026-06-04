import { type DashboardRole, dashboardRoleSchema } from '@review-agent/core';
import { installationMemberships, operatorPrincipals } from '@review-agent/core/db';
import { and, eq, sql } from 'drizzle-orm';
import type { DbClient } from './connection.js';

// ---------------------------------------------------------------------------
// Principal CRUD
// ---------------------------------------------------------------------------

export type CreatePrincipalOpts = {
  readonly id: string;
  readonly username: string;
  readonly passwordHash: string;
};

/**
 * Insert a new operator principal.
 *
 * Converts a unique-constraint violation (duplicate username) into a
 * human-readable error so callers do not need to inspect Postgres error
 * codes directly.
 */
export async function createPrincipal(db: DbClient, opts: CreatePrincipalOpts): Promise<void> {
  try {
    await db.insert(operatorPrincipals).values({
      id: opts.id,
      username: opts.username,
      passwordHash: opts.passwordHash,
    });
  } catch (err) {
    // Postgres unique-violation code: 23505
    const code = (err as { code?: string }).code;
    if (code === '23505') {
      throw new Error(`Username '${opts.username}' is already taken.`);
    }
    throw err;
  }
}

export type PrincipalRow = {
  readonly id: string;
  readonly username: string;
  readonly tokenVersion: number;
  readonly createdAt: Date;
};

/** Return all principals ordered by username. */
export async function listPrincipals(db: DbClient): Promise<ReadonlyArray<PrincipalRow>> {
  const rows = await db
    .select({
      id: operatorPrincipals.id,
      username: operatorPrincipals.username,
      tokenVersion: operatorPrincipals.tokenVersion,
      createdAt: operatorPrincipals.createdAt,
    })
    .from(operatorPrincipals)
    .orderBy(operatorPrincipals.username);
  return rows;
}

export type PrincipalLookup = {
  readonly id: string;
  readonly username: string;
  readonly tokenVersion: number;
};

/** Look up a principal by username. Returns null when not found. */
export async function getPrincipalByUsername(
  db: DbClient,
  username: string,
): Promise<PrincipalLookup | null> {
  const rows = await db
    .select({
      id: operatorPrincipals.id,
      username: operatorPrincipals.username,
      tokenVersion: operatorPrincipals.tokenVersion,
    })
    .from(operatorPrincipals)
    .where(eq(operatorPrincipals.username, username));
  return rows[0] ?? null;
}

/**
 * Update a principal's password hash and atomically bump tokenVersion by 1.
 * Bumping tokenVersion invalidates all existing JWTs for this principal without
 * requiring a token blocklist (spec §18.x).
 */
export async function setPrincipalPassword(
  db: DbClient,
  principalId: string,
  passwordHash: string,
): Promise<void> {
  await db
    .update(operatorPrincipals)
    .set({
      passwordHash,
      tokenVersion: sql`${operatorPrincipals.tokenVersion} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(operatorPrincipals.id, principalId));
}

/**
 * Delete a principal by ID. Membership rows are removed via FK cascade
 * (`ON DELETE CASCADE` defined in the schema).
 */
export async function deletePrincipal(db: DbClient, principalId: string): Promise<void> {
  await db.delete(operatorPrincipals).where(eq(operatorPrincipals.id, principalId));
}

// ---------------------------------------------------------------------------
// Membership CRUD
// ---------------------------------------------------------------------------

/**
 * Upsert a membership: insert (principal, installation) → role, or update the
 * role if the pair already exists. `installationId` is accepted as a string
 * and converted to BigInt for the bigint column.
 */
export async function upsertMembership(
  db: DbClient,
  principalId: string,
  installationId: string,
  role: DashboardRole,
): Promise<void> {
  // Validate role value at the boundary.
  dashboardRoleSchema.parse(role);
  const instId = BigInt(installationId);
  await db
    .insert(installationMemberships)
    .values({ principalId, installationId: instId, role })
    .onConflictDoUpdate({
      target: [installationMemberships.principalId, installationMemberships.installationId],
      set: { role },
    });
}

/**
 * Remove a membership for (principal, installation). No-ops when the row
 * does not exist.
 */
export async function revokeMembership(
  db: DbClient,
  principalId: string,
  installationId: string,
): Promise<void> {
  const instId = BigInt(installationId);
  await db
    .delete(installationMemberships)
    .where(
      and(
        eq(installationMemberships.principalId, principalId),
        eq(installationMemberships.installationId, instId),
      ),
    );
}

export type MembershipRow = {
  readonly installationId: string;
  readonly role: DashboardRole;
};

/** List all memberships for a given principal. */
export async function listMemberships(
  db: DbClient,
  principalId: string,
): Promise<ReadonlyArray<MembershipRow>> {
  const rows = await db
    .select({
      installationId: installationMemberships.installationId,
      role: installationMemberships.role,
    })
    .from(installationMemberships)
    .where(eq(installationMemberships.principalId, principalId))
    .orderBy(installationMemberships.installationId);
  return rows.map((r) => ({
    installationId: String(r.installationId),
    role: dashboardRoleSchema.parse(r.role),
  }));
}
