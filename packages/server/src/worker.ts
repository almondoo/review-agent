import type { JobMessage, QueueClient } from '@review-agent/core';
import { reviewHistory, reviewState, webhookDeliveries } from '@review-agent/core/db';
import type { DbClient } from '@review-agent/db';
import { eq, lt, sql } from 'drizzle-orm';

export type JobHandler = (m: JobMessage) => Promise<void>;

export type WorkerDeps = {
  readonly db: DbClient;
  readonly queue: QueueClient;
  readonly handler: JobHandler;
  readonly debounceWindowMs?: number;
  readonly cleanupIntervalMs?: number;
  readonly retentionDays?: number;
  readonly now?: () => Date;
  readonly stopSignal?: AbortSignal;
};

const DEFAULT_DEBOUNCE_MS = 5_000;
const DEFAULT_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_RETENTION_DAYS = 7;
// `review_history` rows carry a per-row `expires_at` default of
// `now() + 180 days` (spec §7.6). The prune sweep below simply
// deletes rows whose `expires_at` is already in the past, so the
// scheduler cadence does not have to match the 180-day window —
// hourly is enough to keep the table bounded without piling work
// on a single midnight tick.
const DEFAULT_REVIEW_HISTORY_INTERVAL_MS = 60 * 60 * 1000;
// PostgreSQL advisory lock keys for the cleanup electors. Picked
// arbitrarily; documented here so future workers don't collide.
const CLEANUP_LOCK_KEY = 0xabba0001n;
const REVIEW_HISTORY_CLEANUP_LOCK_KEY = 0xabba0002n;

export async function startWorker(deps: WorkerDeps): Promise<void> {
  const cleanup = startIdempotencyCleanup(deps);
  try {
    const opts: Parameters<QueueClient['dequeue']>[1] = {};
    if (deps.stopSignal) (opts as { stopSignal?: AbortSignal }).stopSignal = deps.stopSignal;
    await deps.queue.dequeue(async (m) => {
      const debounced = await shouldDebounce(deps, m);
      if (debounced) return;
      await deps.handler(m);
    }, opts);
  } finally {
    cleanup.stop();
  }
}

async function shouldDebounce(deps: WorkerDeps, m: JobMessage): Promise<boolean> {
  if (m.triggeredBy !== 'pull_request.synchronize') return false;
  const headSha = m.prRef.headSha;
  if (!headSha) return false;
  const window = deps.debounceWindowMs ?? DEFAULT_DEBOUNCE_MS;
  const now = deps.now ?? (() => new Date());
  const stateId = `${m.prRef.owner}/${m.prRef.repo}#${m.prRef.number}`;
  const rows = await deps.db.select().from(reviewState).where(eq(reviewState.id, stateId)).limit(1);
  const latest = rows[0];
  if (!latest) return false;
  const ageMs = now().getTime() - latest.updatedAt.getTime();
  // If the latest stored review is for a newer head (rare race) or if a
  // newer synchronize landed within the debounce window, drop this job.
  if (latest.headSha !== headSha && ageMs < window) return true;
  return false;
}

export type CleanupHandle = {
  readonly stop: () => void;
  readonly tickOnce: () => Promise<void>;
};

export function startIdempotencyCleanup(deps: WorkerDeps): CleanupHandle {
  const interval = deps.cleanupIntervalMs ?? DEFAULT_CLEANUP_INTERVAL_MS;
  const retentionDays = deps.retentionDays ?? DEFAULT_RETENTION_DAYS;
  const now = deps.now ?? (() => new Date());
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;

  async function tickOnce(): Promise<void> {
    const lockHeld = await tryAcquireLock(deps.db);
    if (!lockHeld) return;
    try {
      const cutoff = new Date(now().getTime() - retentionDays * 24 * 3600 * 1000);
      await deps.db.delete(webhookDeliveries).where(lt(webhookDeliveries.receivedAt, cutoff));
    } finally {
      await releaseLock(deps.db);
    }
  }

  function schedule(): void {
    if (stopped) return;
    timer = setTimeout(async () => {
      try {
        await tickOnce();
      } finally {
        schedule();
      }
    }, interval);
    timer.unref?.();
  }

  schedule();

  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
    tickOnce,
  };
}

async function tryAcquireLock(db: DbClient, key: bigint = CLEANUP_LOCK_KEY): Promise<boolean> {
  const result = await db.execute(sql`SELECT pg_try_advisory_lock(${key}) AS got`);
  const row = (result as ReadonlyArray<{ got?: boolean }>)[0];
  return row?.got === true;
}

async function releaseLock(db: DbClient, key: bigint = CLEANUP_LOCK_KEY): Promise<void> {
  await db.execute(sql`SELECT pg_advisory_unlock(${key})`);
}

export type ReviewHistoryCleanupDeps = {
  readonly db: DbClient;
  readonly intervalMs?: number;
  readonly now?: () => Date;
};

/**
 * Periodic prune of `review_history` rows whose `expires_at` has
 * elapsed (spec §7.6 180-day TTL, v1.2 epic #83 Phase 3 / #92).
 * Mirrors the existing `startIdempotencyCleanup` shape — same
 * advisory-lock leader-election pattern so multiple workers can
 * be running and only one will issue the DELETE per tick. A
 * separate lock key (`REVIEW_HISTORY_CLEANUP_LOCK_KEY`) lets the
 * two electors run on independent cadences without serializing.
 *
 * Operators wire this alongside `startWorker` in their entry
 * point. The handle's `tickOnce` is exposed for tests and for
 * an on-demand prune that doesn't wait for the next interval.
 */
export function startReviewHistoryCleanup(deps: ReviewHistoryCleanupDeps): CleanupHandle {
  const interval = deps.intervalMs ?? DEFAULT_REVIEW_HISTORY_INTERVAL_MS;
  const now = deps.now ?? (() => new Date());
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;

  async function tickOnce(): Promise<void> {
    const lockHeld = await tryAcquireLock(deps.db, REVIEW_HISTORY_CLEANUP_LOCK_KEY);
    if (!lockHeld) return;
    try {
      await deps.db.delete(reviewHistory).where(lt(reviewHistory.expiresAt, now()));
    } finally {
      await releaseLock(deps.db, REVIEW_HISTORY_CLEANUP_LOCK_KEY);
    }
  }

  function schedule(): void {
    if (stopped) return;
    timer = setTimeout(async () => {
      try {
        await tickOnce();
      } finally {
        schedule();
      }
    }, interval);
    timer.unref?.();
  }

  schedule();

  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
    tickOnce,
  };
}
