import { describe, expect, it, vi } from 'vitest';
import { createSmtpChannel } from './smtp-channel.js';
import type { NotificationEvent } from './types.js';

const baseEvent: NotificationEvent = {
  type: 'budget.overrun',
  repo: 'owner/repo',
  installationId: '456',
  jobId: 'job-xyz',
  timestamp: '2026-06-04T12:00:00.000Z',
  prNumber: 99,
  summary: 'Budget overrun: $1.20 spent',
};

function makeMockTransport() {
  const sendMail = vi.fn().mockResolvedValue({});
  const transport = { sendMail };
  const factory = vi.fn().mockReturnValue(transport);
  return { factory, transport, sendMail };
}

describe('createSmtpChannel', () => {
  it('sends email via the transport factory with correct fields', async () => {
    const { factory, sendMail } = makeMockTransport();
    const channel = createSmtpChannel({
      host: 'smtp.example.com',
      port: 587,
      secure: false,
      user: 'user@example.com',
      password: 'secret',
      from: 'review-agent@example.com',
      to: ['team@example.com'],
      transportFactory: factory,
    });
    await channel.send(baseEvent);
    expect(factory).toHaveBeenCalledOnce();
    expect(sendMail).toHaveBeenCalledOnce();
    const mail = sendMail.mock.calls[0]?.[0] as {
      from: string;
      to: string[];
      subject: string;
      text: string;
    };
    expect(mail.from).toBe('review-agent@example.com');
    expect(mail.to).toEqual(['team@example.com']);
    expect(mail.subject).toContain('budget.overrun');
    expect(mail.subject).toContain('owner/repo');
  });

  it('payload contains metadata fields and no code/diff/PII', async () => {
    const { factory, sendMail } = makeMockTransport();
    const channel = createSmtpChannel({
      host: 'smtp.example.com',
      port: 587,
      secure: false,
      user: 'user@example.com',
      password: 'secret',
      from: 'agent@example.com',
      to: ['ops@example.com'],
      transportFactory: factory,
    });
    await channel.send(baseEvent);
    const mail = sendMail.mock.calls[0]?.[0] as { text: string; subject: string };
    expect(mail.text).toContain('budget.overrun');
    expect(mail.text).toContain('owner/repo');
    expect(mail.text).toContain('job-xyz');
    expect(mail.text).toContain('PR number: #99');
    expect(mail.text).toContain('Budget overrun');
    // Must not contain raw code/diff markers
    expect(mail.text).not.toMatch(/^diff --git/m);
    expect(mail.text).not.toMatch(/^@@/m);
  });

  it('passes SMTP options to the transport factory', async () => {
    const { factory } = makeMockTransport();
    const channel = createSmtpChannel({
      host: 'mail.host.com',
      port: 465,
      secure: true,
      user: 'u@host.com',
      password: 'pw',
      from: 'f@host.com',
      to: ['r@host.com'],
      transportFactory: factory,
    });
    await channel.send(baseEvent);
    const callArg = factory.mock.calls[0]?.[0] as {
      host: string;
      port: number;
      secure: boolean;
      auth: { user: string; pass: string };
    };
    expect(callArg.host).toBe('mail.host.com');
    expect(callArg.port).toBe(465);
    expect(callArg.secure).toBe(true);
    expect(callArg.auth.user).toBe('u@host.com');
    expect(callArg.auth.pass).toBe('pw');
  });

  it('omits prNumber from subject/body when undefined', async () => {
    const { factory, sendMail } = makeMockTransport();
    const channel = createSmtpChannel({
      host: 'smtp.example.com',
      port: 587,
      secure: false,
      user: 'u',
      password: 'pw',
      from: 'f@example.com',
      to: ['r@example.com'],
      transportFactory: factory,
    });
    await channel.send({ ...baseEvent, prNumber: undefined });
    const mail = sendMail.mock.calls[0]?.[0] as { text: string; subject: string };
    expect(mail.subject).not.toContain('PR #');
    expect(mail.text).not.toContain('PR number:');
  });

  it('falls back to user as "from" when from option omitted', async () => {
    const { factory, sendMail } = makeMockTransport();
    const channel = createSmtpChannel({
      host: 'smtp.example.com',
      port: 587,
      secure: false,
      user: 'fallback@example.com',
      password: 'pw',
      // deliberately omit `from`
      from: 'fallback@example.com',
      to: ['r@example.com'],
      transportFactory: factory,
    });
    await channel.send(baseEvent);
    const mail = sendMail.mock.calls[0]?.[0] as { from: string };
    expect(mail.from).toBe('fallback@example.com');
  });

  it('reports name as "smtp"', () => {
    const { factory } = makeMockTransport();
    const channel = createSmtpChannel({
      host: 'h',
      port: 587,
      secure: false,
      user: 'u',
      password: 'pw',
      from: 'f@h',
      to: ['r@h'],
      transportFactory: factory,
    });
    expect(channel.name).toBe('smtp');
  });
});
