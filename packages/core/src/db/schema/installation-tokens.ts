import { bigint, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

export const installationTokens = pgTable('installation_tokens', {
  installationId: bigint('installation_id', { mode: 'bigint' }).primaryKey(),
  token: text('token').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export type InstallationTokenRow = typeof installationTokens.$inferSelect;
export type NewInstallationToken = typeof installationTokens.$inferInsert;
