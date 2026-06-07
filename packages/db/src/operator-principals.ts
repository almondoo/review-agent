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
  /**
   * scrypt-derived password hash. Required for local principals.
   * Omit (or pass undefined) for OIDC-provisioned principals that have no
   * local password — `password_hash` will be stored as NULL.
   */
  readonly passwordHash?: string;
  /**
   * Authentication provider. Defaults to 'local' when omitted.
   * Use the OIDC issuer string (e.g. 'google', 'okta') for SSO principals.
   */
  readonly provider?: string;
  /**
   * OIDC `sub` claim. NULL for local principals. Together with `provider`,
   * uniquely identifies an external identity (enforced by a partial unique
   * index in the DB).
   */
  readonly externalId?: string;
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
      passwordHash: opts.passwordHash ?? null,
      provider: opts.provider ?? 'local',
      externalId: opts.externalId ?? null,
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
  readonly provider: string;
  readonly tokenVersion: number;
  readonly createdAt: Date;
};

/** Return all principals ordered by username. */
export async function listPrincipals(db: DbClient): Promise<ReadonlyArray<PrincipalRow>> {
  const rows = await db
    .select({
      id: operatorPrincipals.id,
      username: operatorPrincipals.username,
      provider: operatorPrincipals.provider,
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
 * Look up a principal by (provider, externalId).
 * Returns null when no matching principal exists.
 * Used by the OIDC JIT-provisioning path in Phase B.
 */
export async function findPrincipalByExternalId(
  db: DbClient,
  provider: string,
  externalId: string,
): Promise<PrincipalLookup | null> {
  const rows = await db
    .select({
      id: operatorPrincipals.id,
      username: operatorPrincipals.username,
      tokenVersion: operatorPrincipals.tokenVersion,
    })
    .from(operatorPrincipals)
    .where(
      and(eq(operatorPrincipals.provider, provider), eq(operatorPrincipals.externalId, externalId)),
    );
  return rows[0] ?? null;
}

export type UpsertOidcPrincipalOpts = {
  readonly provider: string;
  readonly externalId: string;
  /**
   * Preferred username from the OIDC `preferred_username` or `email` claim.
   *
   * Username collision policy: if the preferred username is already taken by a
   * *different* principal (identified by a different provider/externalId), we
   * append a suffix derived from the first 8 characters of the externalId to
   * make it unique. This is best-effort disambiguation — the admin can always
   * rename later via the CLI. We do NOT merge OIDC identities with existing
   * local principals: a local 'alice' and an OIDC 'alice' become separate
   * principals (e.g. 'alice' and 'alice_ab12cd34').
   */
  readonly username: string;
  readonly id: string;
};

export type UpsertOidcPrincipalResult = {
  readonly id: string;
  readonly username: string;
  /**
   * The principal's current tokenVersion. The OIDC callback must embed this in
   * the issued session JWT so that `sessionAuth` (which re-checks the JWT's
   * tokenVersion against the DB on every request) accepts it. New rows are
   * created with tokenVersion 1 (the schema default).
   */
  readonly tokenVersion: number;
  /** True when a new principal row was inserted; false when an existing one was returned. */
  readonly created: boolean;
};

/** tokenVersion assigned to freshly JIT-provisioned principals (schema default). */
const NEW_PRINCIPAL_TOKEN_VERSION = 1;

/**
 * JIT-provision an OIDC principal.
 *
 * Lookup order:
 *   1. Find by (provider, externalId)  → return existing (created: false).
 *   2. Try to INSERT with the preferred username.
 *      a. Success → return new principal (created: true).
 *      b. Unique-violation on username (23505) → retry with a suffixed username.
 *         The suffix is the first 8 chars of externalId, lowercased.
 *         If the suffixed username is also taken, we let the error propagate
 *         (extremely unlikely; operator must resolve manually).
 *
 * Called only from the OIDC callback handler (Phase B). Callers must hold
 * a valid OIDC `sub` value (non-empty string) before calling this function.
 */
export async function upsertOidcPrincipal(
  db: DbClient,
  opts: UpsertOidcPrincipalOpts,
): Promise<UpsertOidcPrincipalResult> {
  // 1. Check for an existing principal by (provider, externalId).
  const existing = await findPrincipalByExternalId(db, opts.provider, opts.externalId);
  if (existing !== null) {
    return {
      id: existing.id,
      username: existing.username,
      tokenVersion: existing.tokenVersion,
      created: false,
    };
  }

  // 2. Attempt INSERT with preferred username.
  const suffix = opts.externalId.toLowerCase().slice(0, 8);
  const usernameWithSuffix = `${opts.username}_${suffix}`;

  try {
    await db.insert(operatorPrincipals).values({
      id: opts.id,
      username: opts.username,
      passwordHash: null,
      provider: opts.provider,
      externalId: opts.externalId,
      tokenVersion: NEW_PRINCIPAL_TOKEN_VERSION,
    });
    return {
      id: opts.id,
      username: opts.username,
      tokenVersion: NEW_PRINCIPAL_TOKEN_VERSION,
      created: true,
    };
  } catch (err) {
    if ((err as { code?: string }).code !== '23505') {
      throw err;
    }
    // A 23505 here is one of two cases:
    //   (a) a concurrent first-login for the SAME (provider, external_id) — a
    //       JIT race (e.g. double-clicked SSO button). The other request won the
    //       INSERT; re-fetch and return its row.
    //   (b) a username collision with a DIFFERENT principal. Retry with a
    //       suffixed username.
    // Disambiguate by re-checking the external identity first.
    const raced = await findPrincipalByExternalId(db, opts.provider, opts.externalId);
    if (raced !== null) {
      return {
        id: raced.id,
        username: raced.username,
        tokenVersion: raced.tokenVersion,
        created: false,
      };
    }

    // (b) username collision — retry with a suffixed username. opts.id is still
    // a fresh UUID (the INSERT above failed atomically, no row was written).
    try {
      await db.insert(operatorPrincipals).values({
        id: opts.id,
        username: usernameWithSuffix,
        passwordHash: null,
        provider: opts.provider,
        externalId: opts.externalId,
        tokenVersion: NEW_PRINCIPAL_TOKEN_VERSION,
      });
      return {
        id: opts.id,
        username: usernameWithSuffix,
        tokenVersion: NEW_PRINCIPAL_TOKEN_VERSION,
        created: true,
      };
    } catch (retryErr) {
      // A concurrent request may have provisioned the same external_id between
      // our re-check and this retry — return the winner instead of failing.
      if ((retryErr as { code?: string }).code === '23505') {
        const racedAgain = await findPrincipalByExternalId(db, opts.provider, opts.externalId);
        if (racedAgain !== null) {
          return {
            id: racedAgain.id,
            username: racedAgain.username,
            tokenVersion: racedAgain.tokenVersion,
            created: false,
          };
        }
      }
      throw retryErr;
    }
  }
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
