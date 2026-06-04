import { conversationThreads, type NewConversationThreadRow } from '@review-agent/core/db';
import { and, eq, sql } from 'drizzle-orm';
import type { DbClient } from './connection.js';
import { withTenant } from './tenancy.js';

export type ConversationThreadKey = {
  readonly installationId: bigint | number;
  readonly repo: string;
  readonly prNumber: number;
  readonly rootCommentId: string;
};

export type ConversationThreadResult = {
  /** Current turn count before this call increments it. */
  readonly turnCountBefore: number;
  /** Turn count after incrementing (= turnCountBefore + 1). */
  readonly turnCountAfter: number;
};

/**
 * Atomically upsert a `conversation_threads` row and increment `turn_count`.
 *
 * On first call for a thread: inserts with `turn_count = 1`.
 * On subsequent calls: increments `turn_count` in place.
 *
 * Returns the turn count AFTER the increment so callers can compare against
 * `maxTurns` and decide whether to proceed or post a limit-reached note.
 *
 * Runs inside a tenant-scoped transaction so RLS is satisfied.
 */
export async function incrementConversationTurn(
  db: DbClient,
  key: ConversationThreadKey,
): Promise<ConversationThreadResult> {
  const installationId = BigInt(key.installationId);

  return withTenant(db, installationId, async (tx) => {
    // Read current count first so we can return turnCountBefore.
    const existing = await tx
      .select({ turnCount: conversationThreads.turnCount })
      .from(conversationThreads)
      .where(
        and(
          eq(conversationThreads.installationId, installationId),
          eq(conversationThreads.repo, key.repo),
          eq(conversationThreads.prNumber, key.prNumber),
          eq(conversationThreads.rootCommentId, key.rootCommentId),
        ),
      )
      .limit(1);

    const before = existing[0]?.turnCount ?? 0;

    const row: NewConversationThreadRow = {
      installationId,
      repo: key.repo,
      prNumber: key.prNumber,
      rootCommentId: key.rootCommentId,
      turnCount: 1,
      lastTurnAt: new Date(),
    };

    await tx
      .insert(conversationThreads)
      .values(row)
      .onConflictDoUpdate({
        // Conflict target is the unique constraint on the natural key
        // defined in the schema as `conversation_threads_key_uniq`.
        target: [
          conversationThreads.installationId,
          conversationThreads.repo,
          conversationThreads.prNumber,
          conversationThreads.rootCommentId,
        ],
        set: {
          turnCount: sql`${conversationThreads.turnCount} + 1`,
          lastTurnAt: new Date(),
        },
      });

    return { turnCountBefore: before, turnCountAfter: before + 1 };
  });
}

/**
 * Read the current turn count for a conversation thread without modifying it.
 * Returns 0 when the thread has not been seen before.
 */
export async function getConversationTurnCount(
  db: DbClient,
  key: ConversationThreadKey,
): Promise<number> {
  const installationId = BigInt(key.installationId);

  return withTenant(db, installationId, async (tx) => {
    const rows = await tx
      .select({ turnCount: conversationThreads.turnCount })
      .from(conversationThreads)
      .where(
        and(
          eq(conversationThreads.installationId, installationId),
          eq(conversationThreads.repo, key.repo),
          eq(conversationThreads.prNumber, key.prNumber),
          eq(conversationThreads.rootCommentId, key.rootCommentId),
        ),
      )
      .limit(1);

    return rows[0]?.turnCount ?? 0;
  });
}
