/**
 * Amazon SES notification channel (#144).
 *
 * Uses @aws-sdk/client-ses. The `client` parameter is injectable for tests
 * so no real AWS call is made during unit tests.
 *
 * Authentication uses the AWS credential chain — no secret in config.
 * Payload: metadata only — no code, diffs, or PII.
 */

import { SESClient, SendEmailCommand, type SendEmailCommandInput } from '@aws-sdk/client-ses';
import type { NotificationChannel, NotificationEvent } from './types.js';

export type SesChannelOpts = {
  /** AWS region for SES (falls back to AWS_REGION env when absent). */
  readonly region?: string | undefined;
  /** Sender address (RFC 5322 format, must be SES-verified). */
  readonly from: string;
  /** Recipient addresses. */
  readonly to: readonly string[];
  /**
   * DI hook: pre-constructed SESClient for unit tests.
   * Production callers leave this unset — a new client is created from the
   * credential chain.
   */
  readonly client?: Pick<SESClient, 'send'>;
};

function formatSubject(event: NotificationEvent): string {
  const prPart = event.prNumber !== undefined ? ` PR #${event.prNumber.toString()}` : '';
  return `[review-agent] ${event.type}${prPart} — ${event.repo}`;
}

function formatBody(event: NotificationEvent): string {
  const prPart = event.prNumber !== undefined ? `PR number: #${event.prNumber.toString()}\n` : '';
  return [
    `Event type: ${event.type}`,
    `Repository: ${event.repo}`,
    `${prPart}Job ID: ${event.jobId}`,
    `Summary: ${event.summary}`,
    `Timestamp: ${event.timestamp}`,
  ].join('\n');
}

export function createSesChannel(opts: SesChannelOpts): NotificationChannel {
  const client =
    opts.client ?? new SESClient(opts.region !== undefined ? { region: opts.region } : {});

  return {
    name: 'ses',

    async send(event: NotificationEvent): Promise<void> {
      const input: SendEmailCommandInput = {
        Source: opts.from,
        Destination: { ToAddresses: [...opts.to] },
        Message: {
          Subject: { Data: formatSubject(event), Charset: 'UTF-8' },
          Body: { Text: { Data: formatBody(event), Charset: 'UTF-8' } },
        },
      };
      await client.send(new SendEmailCommand(input));
    },
  };
}
