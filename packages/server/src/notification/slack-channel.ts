/**
 * Slack notification channel (#144).
 *
 * Posts to a Slack incoming webhook URL. Uses Node's built-in `fetch`
 * (no extra dependency). The `fetchFn` parameter is injectable for tests.
 *
 * Payload: metadata only — no code, diffs, or PII.
 * Webhook URL must NOT appear in config; pass it from env at construction time.
 */

import type { NotificationChannel, NotificationEvent } from './types.js';

export type SlackChannelOpts = {
  /** Slack incoming webhook URL (from env REVIEW_AGENT_SLACK_WEBHOOK_URL). */
  readonly webhookUrl: string;
  /**
   * DI hook: replaces globalThis.fetch for unit tests.
   * Production callers leave this unset — the global fetch is used.
   */
  readonly fetchFn?: (url: string, init?: RequestInit) => Promise<{ ok: boolean; status: number }>;
};

function formatSlackText(event: NotificationEvent): string {
  const prPart = event.prNumber !== undefined ? ` · PR #${event.prNumber.toString()}` : '';
  return [
    `*[review-agent]* \`${event.type}\``,
    `Repo: ${event.repo}${prPart}`,
    `Job: ${event.jobId}`,
    `Summary: ${event.summary}`,
    `Time: ${event.timestamp}`,
  ].join('\n');
}

export function createSlackChannel(opts: SlackChannelOpts): NotificationChannel {
  const { webhookUrl } = opts;
  const fetchFn = opts.fetchFn ?? globalThis.fetch.bind(globalThis);

  return {
    name: 'slack',

    async send(event: NotificationEvent): Promise<void> {
      const body = JSON.stringify({ text: formatSlackText(event) });
      const res = await fetchFn(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      if (!res.ok) {
        throw new Error(`Slack webhook returned HTTP ${res.status.toString()}`);
      }
    },
  };
}
