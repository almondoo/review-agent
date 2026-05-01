import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  index,
  integer,
  pgPolicy,
  pgTable,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';
import { appRole } from './roles.js';

export const auditLog = pgTable(
  'audit_log',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    ts: timestamp('ts', { withTimezone: true }).defaultNow().notNull(),
    installationId: bigint('installation_id', { mode: 'bigint' }),
    prId: text('pr_id'),
    event: text('event').notNull(),
    model: text('model'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    prevHash: text('prev_hash'),
    hash: text('hash').notNull(),
  },
  (t) => [
    index('audit_log_installation_idx').on(t.installationId, t.ts),
    // Tenants only see their own rows. Rows with installation_id IS NULL
    // are system events (signature failures before tenant is known) and
    // are intentionally invisible to tenant-scoped reads — they are read
    // out of band by an admin/superuser role that bypasses RLS.
    pgPolicy('tenant_isolation', {
      as: 'permissive',
      to: appRole,
      for: 'all',
      using: sql`${t.installationId}::text = current_setting('app.current_tenant', true)`,
      withCheck: sql`${t.installationId} IS NULL OR ${t.installationId}::text = current_setting('app.current_tenant', true)`,
    }),
  ],
).enableRLS();

export type AuditLogRow = typeof auditLog.$inferSelect;
export type NewAuditLogRow = typeof auditLog.$inferInsert;
