import type { JobMessage, QueueClient } from '@review-agent/core';
import { reviewState, webhookDeliveries } from '@review-agent/core/db';
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
// PostgreSQL advisory lock key for the cleanup elector. Picked
// arbitrarily; documented here so future workers don't collide.
const CLEANUP_LOCK_KEY = 0xabba0001n;

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

async function tryAcquireLock(db: DbClient): Promise<boolean> {
  const result = await db.execute(sql`SELECT pg_try_advisory_lock(${CLEANUP_LOCK_KEY}) AS got`);
  const row = (result as ReadonlyArray<{ got?: boolean }>)[0];
  return row?.got === true;
}

async function releaseLock(db: DbClient): Promise<void> {
  await db.execute(sql`SELECT pg_advisory_unlock(${CLEANUP_LOCK_KEY})`);
}
