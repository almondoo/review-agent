import { describe, expect, it, vi } from 'vitest';
import { createNotificationDispatcher } from './dispatcher.js';
import type { NotificationChannel, NotificationEvent } from './types.js';

const enabledConfig = {
  events: { job_failed: true, budget_overrun: true, review_completed: true },
  slack: { enabled: true },
  email: { enabled: false, transport: 'smtp' as const, to: [] },
};

const disabledConfig = {
  events: { job_failed: false, budget_overrun: false, review_completed: false },
  slack: { enabled: false },
  email: { enabled: false, transport: 'smtp' as const, to: [] },
};

function makeChannel(name = 'test'): NotificationChannel & { send: ReturnType<typeof vi.fn> } {
  return { name, send: vi.fn().mockResolvedValue(undefined) };
}

const jobFailedEvent: NotificationEvent = {
  type: 'job.failed',
  repo: 'owner/repo',
  installationId: '1',
  jobId: 'j1',
  timestamp: '2026-06-04T00:00:00.000Z',
  summary: 'failed',
};

describe('createNotificationDispatcher', () => {
  it('dispatches to all channels when event is enabled', async () => {
    const ch1 = makeChannel('ch1');
    const ch2 = makeChannel('ch2');
    const dispatcher = createNotificationDispatcher({
      channels: [ch1, ch2],
      config: enabledConfig,
    });
    await dispatcher.dispatch(jobFailedEvent);
    expect(ch1.send).toHaveBeenCalledOnce();
    expect(ch2.send).toHaveBeenCalledOnce();
  });

  it('does not dispatch when event type is disabled in config', async () => {
    const ch = makeChannel();
    const dispatcher = createNotificationDispatcher({
      channels: [ch],
      config: disabledConfig,
    });
    await dispatcher.dispatch(jobFailedEvent);
    expect(ch.send).not.toHaveBeenCalled();
  });

  it('deduplicates: same jobId+type is sent only once', async () => {
    const ch = makeChannel();
    const dispatcher = createNotificationDispatcher({
      channels: [ch],
      config: enabledConfig,
    });
    await dispatcher.dispatch(jobFailedEvent);
    await dispatcher.dispatch(jobFailedEvent);
    await dispatcher.dispatch(jobFailedEvent);
    expect(ch.send).toHaveBeenCalledTimes(1);
  });

  it('dedup is per jobId+type — different types are not deduped', async () => {
    const ch = makeChannel();
    const dispatcher = createNotificationDispatcher({
      channels: [ch],
      config: enabledConfig,
    });
    await dispatcher.dispatch({ ...jobFailedEvent, type: 'job.failed' });
    await dispatcher.dispatch({ ...jobFailedEvent, type: 'budget.overrun' });
    expect(ch.send).toHaveBeenCalledTimes(2);
  });

  it('dedup is per jobId — different jobIds are not deduped', async () => {
    const ch = makeChannel();
    const dispatcher = createNotificationDispatcher({
      channels: [ch],
      config: enabledConfig,
    });
    await dispatcher.dispatch({ ...jobFailedEvent, jobId: 'j1' });
    await dispatcher.dispatch({ ...jobFailedEvent, jobId: 'j2' });
    expect(ch.send).toHaveBeenCalledTimes(2);
  });

  it('fail-open: a throwing channel does not prevent other channels from receiving the event', async () => {
    const throwingCh: NotificationChannel = {
      name: 'bad',
      send: vi.fn().mockRejectedValue(new Error('network down')),
    };
    const goodCh = makeChannel('good');
    const logger = { warn: vi.fn() };
    const dispatcher = createNotificationDispatcher({
      channels: [throwingCh, goodCh],
      config: enabledConfig,
      logger,
    });
    // Must not throw.
    await expect(dispatcher.dispatch(jobFailedEvent)).resolves.toBeUndefined();
    expect(goodCh.send).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledOnce();
    const [msg, ctx] = logger.warn.mock.calls[0] as [string, Record<string, unknown>];
    expect(msg).toContain('"bad"');
    expect(ctx.error).toContain('network down');
  });

  it('fail-open: dispatch itself does not throw even if all channels throw', async () => {
    const ch: NotificationChannel = {
      name: 'x',
      send: vi.fn().mockRejectedValue(new Error('boom')),
    };
    const dispatcher = createNotificationDispatcher({
      channels: [ch],
      config: enabledConfig,
    });
    await expect(dispatcher.dispatch(jobFailedEvent)).resolves.toBeUndefined();
  });

  it('works with zero channels (no-op dispatcher)', async () => {
    const dispatcher = createNotificationDispatcher({ channels: [], config: enabledConfig });
    await expect(dispatcher.dispatch(jobFailedEvent)).resolves.toBeUndefined();
  });

  it('dispatches review.completed when enabled', async () => {
    const ch = makeChannel();
    const config = {
      ...enabledConfig,
      events: { ...enabledConfig.events, review_completed: true },
    };
    const dispatcher = createNotificationDispatcher({ channels: [ch], config });
    await dispatcher.dispatch({
      ...jobFailedEvent,
      type: 'review.completed',
      jobId: 'j-rc',
    });
    expect(ch.send).toHaveBeenCalledOnce();
  });

  it('skips review.completed when disabled (default)', async () => {
    const ch = makeChannel();
    const config = {
      ...enabledConfig,
      events: { ...enabledConfig.events, review_completed: false },
    };
    const dispatcher = createNotificationDispatcher({ channels: [ch], config });
    await dispatcher.dispatch({
      ...jobFailedEvent,
      type: 'review.completed',
      jobId: 'j-rc2',
    });
    expect(ch.send).not.toHaveBeenCalled();
  });
});
