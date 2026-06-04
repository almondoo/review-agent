import { sql } from 'drizzle-orm';
import { bigint, pgPolicy, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { appRole } from './roles.js';

/**
 * Stores one row per GitHub App installation (org or user account).
 * RLS ON; tenant-scoped via the `tenant_isolation` permissive policy
 * consistent with `installation_tokens` and `installation_secrets` (§16.1).
 *
 * Column notes:
 *   - `app_id` uses bigint to match `installation_id` and accommodate
 *     any future GitHub App ID growth, even though current IDs are small.
 *   - `account_type` domain: 'User' | 'Organization'
 *   - `setup_action` domain: 'install' | 'update' | 'request'
 *
 * RLS policies:
 *   - `tenant_isolation` (FOR ALL): scopes reads/writes to the current tenant.
 *
 * The spec (§8.2.3) requires that GET /api/integrations runs the installation
 * count either inside a withTenant transaction or via a BYPASSRLS admin role.
 * No additional permissive SELECT policy is added — the fail-closed guarantee
 * (unset tenant GUC = zero rows) is preserved for all SELECT paths.
 *
 * Migrations: `0006_github_installations.sql`.
 */
export const githubInstallations = pgTable(
  'github_installations',
  {
    installationId: bigint('installation_id', { mode: 'bigint' }).primaryKey(),
    accountLogin: text('account_login').notNull(),
    accountType: text('account_type').notNull(),
    appId: bigint('app_id', { mode: 'bigint' }).notNull(),
    setupAction: text('setup_action').notNull(),
    suspendedAt: timestamp('suspended_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    pgPolicy('tenant_isolation', {
      as: 'permissive',
      to: appRole,
      for: 'all',
      using: sql`${t.installationId}::text = current_setting('app.current_tenant', true)`,
      withCheck: sql`${t.installationId}::text = current_setting('app.current_tenant', true)`,
    }),
  ],
).enableRLS();

export type GithubInstallationRow = typeof githubInstallations.$inferSelect;
export type NewGithubInstallation = typeof githubInstallations.$inferInsert;
