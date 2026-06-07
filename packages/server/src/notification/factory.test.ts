import type { NotificationsConfig } from '@review-agent/config';
import { describe, expect, it } from 'vitest';
import { buildNotificationChannels } from './factory.js';

function baseConfig(): NotificationsConfig {
  return {
    events: { job_failed: true, budget_overrun: true, review_completed: false },
    slack: { enabled: false },
    email: { enabled: false, transport: 'smtp', to: [] },
  };
}

describe('buildNotificationChannels', () => {
  it('returns empty array when all channels disabled', () => {
    const channels = buildNotificationChannels(baseConfig(), {});
    expect(channels).toHaveLength(0);
  });

  it('returns slack channel when enabled and URL present', () => {
    const config = { ...baseConfig(), slack: { enabled: true } };
    const channels = buildNotificationChannels(config, {
      REVIEW_AGENT_SLACK_WEBHOOK_URL: 'https://hooks.slack.com/T/B/X',
    });
    expect(channels).toHaveLength(1);
    expect(channels[0]?.name).toBe('slack');
  });

  it('skips slack channel when URL is missing even if enabled', () => {
    const config = { ...baseConfig(), slack: { enabled: true } };
    const channels = buildNotificationChannels(config, {});
    expect(channels).toHaveLength(0);
  });

  it('skips slack channel when URL is empty string', () => {
    const config = { ...baseConfig(), slack: { enabled: true } };
    const channels = buildNotificationChannels(config, { REVIEW_AGENT_SLACK_WEBHOOK_URL: '' });
    expect(channels).toHaveLength(0);
  });

  it('returns smtp channel when enabled, smtp config present, and password in env', () => {
    const config: NotificationsConfig = {
      ...baseConfig(),
      email: {
        enabled: true,
        transport: 'smtp',
        from: 'agent@example.com',
        to: ['ops@example.com'],
        smtp: { host: 'smtp.example.com', port: 587, secure: false, user: 'u@example.com' },
      },
    };
    const channels = buildNotificationChannels(config, { REVIEW_AGENT_SMTP_PASSWORD: 'secret' });
    expect(channels).toHaveLength(1);
    expect(channels[0]?.name).toBe('smtp');
  });

  it('skips smtp channel when password is missing', () => {
    const config: NotificationsConfig = {
      ...baseConfig(),
      email: {
        enabled: true,
        transport: 'smtp',
        from: 'agent@example.com',
        to: ['ops@example.com'],
        smtp: { host: 'smtp.example.com', port: 587, secure: false, user: 'u@example.com' },
      },
    };
    const channels = buildNotificationChannels(config, {});
    expect(channels).toHaveLength(0);
  });

  it('skips smtp channel when smtp config block is missing', () => {
    const config: NotificationsConfig = {
      ...baseConfig(),
      email: {
        enabled: true,
        transport: 'smtp',
        from: 'agent@example.com',
        to: ['ops@example.com'],
        // smtp config absent
      },
    };
    const channels = buildNotificationChannels(config, { REVIEW_AGENT_SMTP_PASSWORD: 'secret' });
    expect(channels).toHaveLength(0);
  });

  it('returns ses channel when enabled, ses transport, from and to set', () => {
    const config: NotificationsConfig = {
      ...baseConfig(),
      email: {
        enabled: true,
        transport: 'ses',
        from: 'agent@example.com',
        to: ['ops@example.com'],
        ses: { region: 'us-east-1' },
      },
    };
    const channels = buildNotificationChannels(config, {});
    expect(channels).toHaveLength(1);
    expect(channels[0]?.name).toBe('ses');
  });

  it('skips ses channel when from is missing', () => {
    const config: NotificationsConfig = {
      ...baseConfig(),
      email: {
        enabled: true,
        transport: 'ses',
        // from absent
        to: ['ops@example.com'],
      },
    };
    const channels = buildNotificationChannels(config, {});
    expect(channels).toHaveLength(0);
  });

  it('skips ses channel when to list is empty', () => {
    const config: NotificationsConfig = {
      ...baseConfig(),
      email: {
        enabled: true,
        transport: 'ses',
        from: 'agent@example.com',
        to: [], // empty
      },
    };
    const channels = buildNotificationChannels(config, {});
    expect(channels).toHaveLength(0);
  });

  it('returns both slack and smtp channels when both configured', () => {
    const config: NotificationsConfig = {
      ...baseConfig(),
      slack: { enabled: true },
      email: {
        enabled: true,
        transport: 'smtp',
        from: 'agent@example.com',
        to: ['ops@example.com'],
        smtp: { host: 'smtp.example.com', port: 587, secure: false, user: 'u@example.com' },
      },
    };
    const channels = buildNotificationChannels(config, {
      REVIEW_AGENT_SLACK_WEBHOOK_URL: 'https://hooks.slack.com/T/B/X',
      REVIEW_AGENT_SMTP_PASSWORD: 'secret',
    });
    expect(channels).toHaveLength(2);
    const names = channels.map((c) => c.name).sort();
    expect(names).toEqual(['slack', 'smtp']);
  });
});
