import {
  bigint,
  bigserial,
  doublePrecision,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';
import type { COST_LEDGER_PHASES, COST_LEDGER_STATUSES } from '../../review.js';

export const costLedger = pgTable(
  'cost_ledger',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    installationId: bigint('installation_id', { mode: 'bigint' }).notNull(),
    jobId: text('job_id').notNull(),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    callPhase: text('call_phase').notNull().$type<(typeof COST_LEDGER_PHASES)[number]>(),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    cacheReadTokens: integer('cache_read_tokens').notNull().default(0),
    cacheCreationTokens: integer('cache_creation_tokens').notNull().default(0),
    costUsd: doublePrecision('cost_usd').notNull().default(0),
    status: text('status').notNull().$type<(typeof COST_LEDGER_STATUSES)[number]>(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('cost_ledger_job_idx').on(t.installationId, t.jobId),
    index('cost_ledger_created_at_idx').on(t.createdAt),
  ],
);

export type CostLedgerRowDb = typeof costLedger.$inferSelect;
export type NewCostLedgerRow = typeof costLedger.$inferInsert;

export const installationCostDaily = pgTable(
  'installation_cost_daily',
  {
    installationId: bigint('installation_id', { mode: 'bigint' }).notNull(),
    date: text('date').notNull(),
    costUsd: doublePrecision('cost_usd').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.installationId, t.date] })],
);

export type InstallationCostDailyRow = typeof installationCostDaily.$inferSelect;
export type NewInstallationCostDailyRow = typeof installationCostDaily.$inferInsert;
