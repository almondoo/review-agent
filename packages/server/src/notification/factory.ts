/**
 * Notification channel factory (#144).
 *
 * Reads the effective config and process env to assemble the active
 * channel list. No secrets are stored in config — they come from env.
 *
 * Environment variables:
 *   REVIEW_AGENT_SLACK_WEBHOOK_URL   — Slack incoming webhook URL
 *   REVIEW_AGENT_SMTP_PASSWORD       — SMTP account password
 *
 * AWS credential chain supplies SES credentials; no env key needed here.
 */

import type { NotificationsConfig } from '@review-agent/config';
import { createSesChannel } from './ses-channel.js';
import { createSlackChannel } from './slack-channel.js';
import { createSmtpChannel } from './smtp-channel.js';
import type { NotificationChannel } from './types.js';

export type BuildNotificationChannelsEnv = {
  readonly REVIEW_AGENT_SLACK_WEBHOOK_URL?: string | undefined;
  readonly REVIEW_AGENT_SMTP_PASSWORD?: string | undefined;
};

/**
 * Assemble the list of active notification channels from config + env.
 *
 * Rules:
 *  - Slack: `config.slack.enabled === true` AND env has `REVIEW_AGENT_SLACK_WEBHOOK_URL`.
 *    If enabled but URL is missing, the channel is silently skipped (no channel = no-op).
 *  - Email/SMTP: `config.email.enabled === true` AND `config.email.transport === 'smtp'`
 *    AND `config.email.smtp` is configured AND env has `REVIEW_AGENT_SMTP_PASSWORD`.
 *    Missing password → channel silently skipped.
 *  - Email/SES: `config.email.enabled === true` AND `config.email.transport === 'ses'`
 *    AND `config.email.from` is set AND `config.email.to` is non-empty.
 *    AWS credentials come from the credential chain — no env check here.
 *
 * Returns an empty array when no channels can be assembled (dispatcher is a no-op).
 */
export function buildNotificationChannels(
  config: NotificationsConfig,
  env: BuildNotificationChannelsEnv,
): NotificationChannel[] {
  const channels: NotificationChannel[] = [];

  // Slack channel
  if (config.slack.enabled) {
    const url = env.REVIEW_AGENT_SLACK_WEBHOOK_URL;
    if (url !== undefined && url.length > 0) {
      channels.push(createSlackChannel({ webhookUrl: url }));
    }
  }

  // Email channel
  if (config.email.enabled) {
    if (config.email.transport === 'smtp') {
      const smtpCfg = config.email.smtp;
      const password = env.REVIEW_AGENT_SMTP_PASSWORD;
      if (smtpCfg !== undefined && password !== undefined && password.length > 0) {
        channels.push(
          createSmtpChannel({
            host: smtpCfg.host,
            port: smtpCfg.port,
            secure: smtpCfg.secure,
            user: smtpCfg.user,
            password,
            from: config.email.from ?? smtpCfg.user,
            to: config.email.to,
          }),
        );
      }
    } else {
      // transport === 'ses'
      const from = config.email.from;
      if (from !== undefined && config.email.to.length > 0) {
        channels.push(
          createSesChannel({
            region: config.email.ses?.region,
            from,
            to: config.email.to,
          }),
        );
      }
    }
  }

  return channels;
}
