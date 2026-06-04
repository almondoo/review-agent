import { integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * Stores operator (dashboard) principals — human users who log in to the
 * review-agent control plane via username + password.
 *
 * RLS is intentionally OMITTED on this table. It is the control-plane
 * authentication table: queries against it must run before any tenant GUC is
 * set (i.e., before `withTenant` establishes `app.current_tenant`).
 * Attaching a tenant-scoped RLS policy would make the table unreadable at
 * login time, defeating its purpose. Access is restricted at the application
 * layer (server routes require the BYPASSRLS admin role or a direct DB
 * connection without the tenant GUC for these queries).
 *
 * Migration: `0011_dashboard_auth.sql`.
 */
export const operatorPrincipals = pgTable('operator_principals', {
  id: text('id').primaryKey(),
  username: text('username').notNull().unique(),
  /**
   * scrypt-derived password hash in the format:
   *   `scrypt$<N>$<r>$<p>$<saltB64>$<hashB64>`
   * See `packages/core/src/auth/password.ts` for details.
   */
  passwordHash: text('password_hash').notNull(),
  /**
   * Monotonically increasing version counter. Incrementing this value
   * invalidates all existing JWTs issued for this principal, without
   * requiring a token blocklist (spec §18.x).
   */
  tokenVersion: integer('token_version').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export type OperatorPrincipalRow = typeof operatorPrincipals.$inferSelect;
export type NewOperatorPrincipal = typeof operatorPrincipals.$inferInsert;
