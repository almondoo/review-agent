import type {
  CostLedgerPhase,
  CostLedgerStatus,
  CostTotalsReader,
  RecordPhaseInput,
} from '@review-agent/core';
import { costLedger, installationCostDaily, type NewCostLedgerRow } from '@review-agent/core/db';
import { and, eq, sql } from 'drizzle-orm';
import type { DbClient } from './connection.js';

export function createCostLedgerRecorder(db: DbClient) {
  return async (input: RecordPhaseInput): Promise<void> => {
    const row: NewCostLedgerRow = {
      installationId: input.installationId,
      jobId: input.jobId,
      provider: input.provider,
      model: input.model,
      callPhase: input.callPhase as CostLedgerPhase,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      cacheReadTokens: input.cacheReadTokens ?? 0,
      cacheCreationTokens: input.cacheCreationTokens ?? 0,
      costUsd: input.costUsd,
      status: input.status as CostLedgerStatus,
    };
    await db.transaction(async (tx) => {
      await tx.insert(costLedger).values(row);
      const today = isoDate(new Date());
      await tx
        .insert(installationCostDaily)
        .values({
          installationId: input.installationId,
          date: today,
          costUsd: input.costUsd,
        })
        .onConflictDoUpdate({
          target: [installationCostDaily.installationId, installationCostDaily.date],
          set: {
            costUsd: sql`${installationCostDaily.costUsd} + ${input.costUsd}`,
            updatedAt: new Date(),
          },
        });
    });
  };
}

export function createCostTotalsReader(db: DbClient): CostTotalsReader {
  return async ({ installationId, jobId, date }) => {
    const runningRows = await db
      .select({
        total: sql<number>`coalesce(sum(${costLedger.costUsd}), 0)`,
      })
      .from(costLedger)
      .where(and(eq(costLedger.installationId, installationId), eq(costLedger.jobId, jobId)));
    const dailyRows = await db
      .select()
      .from(installationCostDaily)
      .where(
        and(
          eq(installationCostDaily.installationId, installationId),
          eq(installationCostDaily.date, date),
        ),
      )
      .limit(1);
    return {
      running: Number(runningRows[0]?.total ?? 0),
      daily: Number(dailyRows[0]?.costUsd ?? 0),
    };
  };
}

function isoDate(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
