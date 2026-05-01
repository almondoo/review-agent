import { sql } from 'drizzle-orm';
import { bigint, pgPolicy, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { appRole } from './roles.js';

export const installationTokens = pgTable(
  'installation_tokens',
  {
    installationId: bigint('installation_id', { mode: 'bigint' }).primaryKey(),
    token: text('token').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
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

export type InstallationTokenRow = typeof installationTokens.$inferSelect;
export type NewInstallationToken = typeof installationTokens.$inferInsert;
