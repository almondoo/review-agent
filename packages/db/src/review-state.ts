import type { ReviewState } from '@review-agent/core';
import { reviewState } from '@review-agent/core/db';
import { eq } from 'drizzle-orm';
import type { DbClient } from './connection.js';

export type ReviewStateLookup = {
  installationId: bigint;
  prId: string;
};

export type ReviewStateMirror = {
  read(q: ReviewStateLookup): Promise<ReviewState | null>;
  upsert(q: ReviewStateLookup & { headSha: string; state: ReviewState }): Promise<void>;
};

export function createReviewStateMirror(db: DbClient): ReviewStateMirror {
  async function read(q: ReviewStateLookup): Promise<ReviewState | null> {
    const rows = await db
      .select()
      .from(reviewState)
      .where(eq(reviewState.id, idFor(q)))
      .limit(1);
    return rows[0]?.state ?? null;
  }

  async function upsert(
    q: ReviewStateLookup & { headSha: string; state: ReviewState },
  ): Promise<void> {
    await db
      .insert(reviewState)
      .values({
        id: idFor(q),
        installationId: q.installationId,
        prId: q.prId,
        headSha: q.headSha,
        state: q.state,
      })
      .onConflictDoUpdate({
        target: reviewState.id,
        set: {
          headSha: q.headSha,
          state: q.state,
          updatedAt: new Date(),
        },
      });
  }

  return { read, upsert };
}

function idFor(q: ReviewStateLookup): string {
  return `${q.installationId}:${q.prId}`;
}

// Read-with-fallback helper. Postgres mirror is consulted first; on miss
// the caller must read the hidden state comment via the VCS adapter.
// On conflict, the hidden comment is canonical (§12.1) and the mirror is
// updated to match.
export type StateReader = {
  fromMirror: () => Promise<ReviewState | null>;
  fromHiddenComment: () => Promise<ReviewState | null>;
};

export async function loadReviewState(
  reader: StateReader,
  upsert: (state: ReviewState, headSha: string) => Promise<void>,
): Promise<ReviewState | null> {
  const [mirror, hidden] = await Promise.all([reader.fromMirror(), reader.fromHiddenComment()]);
  if (hidden && (!mirror || mirror.reviewedAt !== hidden.reviewedAt)) {
    if (hidden.lastReviewedSha) await upsert(hidden, hidden.lastReviewedSha);
    return hidden;
  }
  return mirror ?? hidden ?? null;
}
