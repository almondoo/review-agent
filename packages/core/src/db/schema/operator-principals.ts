import { sql } from 'drizzle-orm';
import { index, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * Stores operator (dashboard) principals — human users who log in to the
 * review-agent control plane via username + password or via OIDC (SSO).
 *
 * RLS is intentionally OMITTED on this table. It is the control-plane
 * authentication table: queries against it must run before any tenant GUC is
 * set (i.e., before `withTenant` establishes `app.current_tenant`).
 * Attaching a tenant-scoped RLS policy would make the table unreadable at
 * login time, defeating its purpose. Access is restricted at the application
 * layer (server routes require the BYPASSRLS admin role or a direct DB
 * connection without the tenant GUC for these queries).
 *
 * Migrations: `0011_dashboard_auth.sql`, `0014_oidc_principals.sql`.
 */
export const operatorPrincipals = pgTable(
  'operator_principals',
  {
    id: text('id').primaryKey(),
    username: text('username').notNull().unique(),
    /**
     * scrypt-derived password hash in the format:
     *   `scrypt$<N>$<r>$<p>$<saltB64>$<hashB64>`
     * See `packages/core/src/auth/password.ts` for details.
     *
     * NULL for OIDC-provisioned principals who authenticate via SSO and
     * have no local password. Password login is refused when this is NULL.
     */
    passwordHash: text('password_hash'),
    /**
     * Authentication provider. 'local' for username+password principals;
     * an OIDC issuer identifier (e.g. 'google', 'okta') for SSO principals
     * provisioned via JIT on first OIDC login.
     */
    provider: text('provider').notNull().default('local'),
    /**
     * External identity reference from the OIDC provider (`sub` claim).
     * NULL for local principals. Together with `provider`, forms a unique
     * identity across OIDC providers (enforced by partial unique index
     * `operator_principals_provider_external_id_uidx` where external_id IS NOT NULL).
     */
    externalId: text('external_id'),
    /**
     * Monotonically increasing version counter. Incrementing this value
     * invalidates all existing JWTs issued for this principal, without
     * requiring a token blocklist (spec §18.x).
     */
    tokenVersion: integer('token_version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    /**
     * Partial unique index: (provider, external_id) must be unique when
     * external_id IS NOT NULL. Prevents duplicate JIT-provisioned OIDC
     * principals. Rows with external_id IS NULL (local users) are excluded
     * from this constraint.
     */
    index('operator_principals_provider_external_id_uidx')
      .on(table.provider, table.externalId)
      .where(sql`${table.externalId} IS NOT NULL`),
  ],
);

export type OperatorPrincipalRow = typeof operatorPrincipals.$inferSelect;
export type NewOperatorPrincipal = typeof operatorPrincipals.$inferInsert;
