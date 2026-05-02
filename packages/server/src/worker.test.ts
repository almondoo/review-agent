import { describe, expect, it, vi } from 'vitest';
import { startIdempotencyCleanup, startWorker } from './worker.js';

function makeDb(initial: { reviewState?: { id: string; headSha: string; updatedAt: Date } } = {}) {
  const stateRows = initial.reviewState ? [initial.reviewState] : [];
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => stateRows.slice(0, 1),
        }),
      }),
    }),
    delete: () => ({
      where: async () => undefined,
    }),
    execute: vi.fn().mockImplementation(async () => [{ got: true }]),
  };
}

const baseMsg = {
  jobId: 'j',
  installationId: '11',
  prRef: { platform: 'github' as const, owner: 'o', repo: 'r', number: 1, headSha: 'old1' },
  triggeredBy: 'pull_request.synchronize' as const,
  enqueuedAt: '2026-04-30T00:00:00.000Z',
};

describe('startWorker debounce', () => {
  it('drops a synchronize job whose headSha is older than the latest stored within the window', async () => {
    const handler = vi.fn();
    const db = makeDb({
      reviewState: {
        id: 'o/r#1',
        headSha: 'newer1',
        updatedAt: new Date('2026-04-30T00:00:01Z'),
      },
    });
    const queue = {
      enqueue: vi.fn(),
      dequeue: vi.fn(async (cb: (m: typeof baseMsg) => Promise<void>) => {
        await cb(baseMsg);
      }),
    };
    await startWorker({
      // biome-ignore lint/suspicious/noExplicitAny: mock
      db: db as any,
      queue,
      handler,
      debounceWindowMs: 60_000,
      cleanupIntervalMs: 1_000_000,
      now: () => new Date('2026-04-30T00:00:02Z'),
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it('runs the handler when no latest state exists', async () => {
    const handler = vi.fn();
    const queue = {
      enqueue: vi.fn(),
      dequeue: vi.fn(async (cb: (m: typeof baseMsg) => Promise<void>) => {
        await cb(baseMsg);
      }),
    };
    await startWorker({
      // biome-ignore lint/suspicious/noExplicitAny: mock
      db: makeDb() as any,
      queue,
      handler,
      cleanupIntervalMs: 1_000_000,
    });
    expect(handler).toHaveBeenCalledOnce();
  });

  it('runs the handler for non-synchronize triggers', async () => {
    const handler = vi.fn();
    const queue = {
      enqueue: vi.fn(),
      dequeue: vi.fn(async (cb: (m: typeof baseMsg) => Promise<void>) => {
        await cb({ ...baseMsg, triggeredBy: 'pull_request.opened' });
      }),
    };
    const db = makeDb({
      reviewState: { id: 'o/r#1', headSha: 'other', updatedAt: new Date() },
    });
    await startWorker({
      // biome-ignore lint/suspicious/noExplicitAny: mock
      db: db as any,
      queue,
      handler,
      cleanupIntervalMs: 1_000_000,
    });
    expect(handler).toHaveBeenCalledOnce();
  });

  it('runs the handler when re-delivered for the same headSha (debounce only fires for newer SHAs)', async () => {
    // Same headSha + same window = duplicate delivery, not a "newer commit
    // landed" race. The worker must still run so SQS at-least-once retries
    // do not silently swallow legitimate idempotent replays.
    const handler = vi.fn();
    const db = makeDb({
      reviewState: {
        id: 'o/r#1',
        headSha: baseMsg.prRef.headSha,
        updatedAt: new Date('2026-04-30T00:00:01Z'),
      },
    });
    const queue = {
      enqueue: vi.fn(),
      dequeue: vi.fn(async (cb: (m: typeof baseMsg) => Promise<void>) => {
        await cb(baseMsg);
      }),
    };
    await startWorker({
      // biome-ignore lint/suspicious/noExplicitAny: mock
      db: db as any,
      queue,
      handler,
      debounceWindowMs: 60_000,
      cleanupIntervalMs: 1_000_000,
      now: () => new Date('2026-04-30T00:00:02Z'),
    });
    expect(handler).toHaveBeenCalledOnce();
  });

  it('runs the handler when the latest stored state is older than the debounce window', async () => {
    // Boundary: ageMs >= window means we don't drop, even if heads differ.
    const handler = vi.fn();
    const db = makeDb({
      reviewState: {
        id: 'o/r#1',
        headSha: 'newer1',
        updatedAt: new Date('2026-04-30T00:00:00Z'),
      },
    });
    const queue = {
      enqueue: vi.fn(),
      dequeue: vi.fn(async (cb: (m: typeof baseMsg) => Promise<void>) => {
        await cb(baseMsg);
      }),
    };
    await startWorker({
      // biome-ignore lint/suspicious/noExplicitAny: mock
      db: db as any,
      queue,
      handler,
      debounceWindowMs: 1_000,
      cleanupIntervalMs: 1_000_000,
      now: () => new Date('2026-04-30T01:00:00Z'),
    });
    expect(handler).toHaveBeenCalledOnce();
  });
});

describe('startIdempotencyCleanup', () => {
  it('tickOnce deletes when advisory lock is acquired', async () => {
    const db = makeDb();
    const cleanup = startIdempotencyCleanup({
      // biome-ignore lint/suspicious/noExplicitAny: mock
      db: db as any,
      queue: { enqueue: vi.fn(), dequeue: vi.fn() },
      handler: vi.fn(),
      cleanupIntervalMs: 1_000_000,
    });
    await cleanup.tickOnce();
    expect(db.execute).toHaveBeenCalled();
    cleanup.stop();
  });

  it('tickOnce skips deletion when advisory lock is denied', async () => {
    const db = makeDb();
    db.execute = vi.fn().mockResolvedValue([{ got: false }]);
    const deleteCall = vi.fn().mockResolvedValue(undefined);
    // biome-ignore lint/suspicious/noExplicitAny: mock surface
    (db as any).delete = () => ({ where: deleteCall });
    const cleanup = startIdempotencyCleanup({
      // biome-ignore lint/suspicious/noExplicitAny: mock
      db: db as any,
      queue: { enqueue: vi.fn(), dequeue: vi.fn() },
      handler: vi.fn(),
      cleanupIntervalMs: 1_000_000,
    });
    await cleanup.tickOnce();
    expect(deleteCall).not.toHaveBeenCalled();
    cleanup.stop();
  });
});
