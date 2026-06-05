/**
 * Notification dispatcher (#144).
 *
 * - Respects per-event-type enable/disable flags from config.
 * - Deduplicates by `${jobId}:${type}` to prevent retry spam.
 * - Fail-open: a failing channel is logged and skipped; other channels
 *   still receive the event, and dispatch never throws to the caller.
 * - Fans out to all configured channels in parallel.
 */

import type { NotificationsConfig } from '@review-agent/config';
import type { NotificationChannel, NotificationEvent, NotificationEventType } from './types.js';

export type DispatcherLogger = {
  warn(message: string, ctx?: Record<string, unknown>): void;
};

export type NotificationDispatcher = {
  dispatch(event: NotificationEvent): Promise<void>;
};

export type CreateNotificationDispatcherOpts = {
  readonly channels: readonly NotificationChannel[];
  readonly config: NotificationsConfig;
  readonly logger?: DispatcherLogger | undefined;
};

/** Map config event key to NotificationEventType. */
const EVENT_KEY_MAP: Record<NotificationEventType, keyof NotificationsConfig['events']> = {
  'job.failed': 'job_failed',
  'budget.overrun': 'budget_overrun',
  'review.completed': 'review_completed',
};

export function createNotificationDispatcher(
  opts: CreateNotificationDispatcherOpts,
): NotificationDispatcher {
  const { channels, config, logger } = opts;
  /** In-memory dedup set: `${jobId}:${type}`. Process-lifetime only. */
  const sent = new Set<string>();

  return {
    async dispatch(event: NotificationEvent): Promise<void> {
      // 1. Event-type gate.
      const configKey = EVENT_KEY_MAP[event.type];
      if (!config.events[configKey]) return;

      // 2. Deduplication.
      const dedupKey = `${event.jobId}:${event.type}`;
      if (sent.has(dedupKey)) return;
      sent.add(dedupKey);

      // 3. Fan-out (fail-open per channel).
      await Promise.all(
        channels.map(async (ch) => {
          try {
            await ch.send(event);
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            logger?.warn(`[notification] channel "${ch.name}" failed`, {
              channel: ch.name,
              event: event.type,
              jobId: event.jobId,
              error: errMsg,
            });
          }
        }),
      );
    },
  };
}
