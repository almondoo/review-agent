/**
 * SMTP email notification channel (#144).
 *
 * Uses nodemailer. The `transportFactory` parameter is injectable for tests
 * so no real SMTP connection is made during unit tests.
 *
 * SMTP password must NOT appear in config; pass it from env at construction time.
 * Payload: metadata only — no code, diffs, or PII.
 */

import nodemailer from 'nodemailer';
import type Mail from 'nodemailer/lib/mailer/index.js';
import type SMTPTransport from 'nodemailer/lib/smtp-transport/index.js';
import type { NotificationChannel, NotificationEvent } from './types.js';

export type SmtpChannelOpts = {
  readonly host: string;
  readonly port: number;
  readonly secure: boolean;
  /** SMTP account username. */
  readonly user: string;
  /** SMTP account password (from env REVIEW_AGENT_SMTP_PASSWORD). */
  readonly password: string;
  /** Sender address (RFC 5322). */
  readonly from: string;
  /** Recipient addresses. */
  readonly to: readonly string[];
  /**
   * DI hook: factory for the nodemailer transport.
   * Tests inject a mock; production callers leave this unset.
   */
  readonly transportFactory?: (opts: SMTPTransport.Options) => Pick<Mail, 'sendMail'>;
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

export function createSmtpChannel(opts: SmtpChannelOpts): NotificationChannel {
  const factory = opts.transportFactory ?? nodemailer.createTransport;

  const transportOpts: SMTPTransport.Options = {
    host: opts.host,
    port: opts.port,
    secure: opts.secure,
    auth: { user: opts.user, pass: opts.password },
  };

  return {
    name: 'smtp',

    async send(event: NotificationEvent): Promise<void> {
      const transport = factory(transportOpts);
      await transport.sendMail({
        from: opts.from,
        to: [...opts.to],
        subject: formatSubject(event),
        text: formatBody(event),
      });
    },
  };
}
