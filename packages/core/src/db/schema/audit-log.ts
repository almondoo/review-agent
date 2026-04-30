import { bigint, bigserial, index, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

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
  (t) => [index('audit_log_installation_idx').on(t.installationId, t.ts)],
);

export type AuditLogRow = typeof auditLog.$inferSelect;
export type NewAuditLogRow = typeof auditLog.$inferInsert;
