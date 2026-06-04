import { bigint, index, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';
import { githubInstallations } from './github-installations.js';
import { operatorPrincipals } from './operator-principals.js';

/**
 * Maps operator principals to GitHub App installations, with a role.
 *
 * Role values: 'viewer' | 'editor' | 'admin'  (see DashboardRole in dashboard-roles.ts).
 * Stored as plain text; validated at the application layer via dashboardRoleSchema.
 *
 * RLS is intentionally OMITTED on this table for the same reason as
 * `operator_principals`: membership lookups happen in the authentication /
 * authorisation middleware layer, before any tenant GUC is set. Tenant-scoped
 * RLS would prevent a principal from discovering which installations they
 * belong to at login time. Access is controlled at the application layer.
 *
 * Migration: `0011_dashboard_auth.sql`.
 */
export const installationMemberships = pgTable(
  'installation_memberships',
  {
    principalId: text('principal_id')
      .notNull()
      .references(() => operatorPrincipals.id, { onDelete: 'cascade' }),
    /**
     * References github_installations(installation_id) (bigint PK).
     */
    installationId: bigint('installation_id', { mode: 'bigint' })
      .notNull()
      .references(() => githubInstallations.installationId, { onDelete: 'cascade' }),
    /**
     * RBAC role for this principal on this installation.
     * Allowed values: 'viewer' | 'editor' | 'admin'.
     * Enforced at application layer via dashboardRoleSchema.
     */
    role: text('role').notNull().default('viewer'),
    grantedAt: timestamp('granted_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.principalId, t.installationId] }),
    index('installation_memberships_principal_id_idx').on(t.principalId),
  ],
);

export type InstallationMembershipRow = typeof installationMemberships.$inferSelect;
export type NewInstallationMembership = typeof installationMemberships.$inferInsert;
