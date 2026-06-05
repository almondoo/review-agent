import { SendEmailCommand } from '@aws-sdk/client-ses';
import { describe, expect, it, vi } from 'vitest';
import { createSesChannel } from './ses-channel.js';
import type { NotificationEvent } from './types.js';

const baseEvent: NotificationEvent = {
  type: 'review.completed',
  repo: 'owner/repo',
  installationId: '789',
  jobId: 'job-ses',
  timestamp: '2026-06-04T08:00:00.000Z',
  prNumber: 11,
  summary: 'Review completed: 2 findings',
};

function makeMockClient() {
  const send = vi.fn().mockResolvedValue({});
  return { send };
}

describe('createSesChannel', () => {
  it('calls client.send with a SendEmailCommand targeting correct addresses', async () => {
    const client = makeMockClient();
    const channel = createSesChannel({
      from: 'agent@example.com',
      to: ['dev@example.com'],
      client,
    });
    await channel.send(baseEvent);
    expect(client.send).toHaveBeenCalledOnce();
    const cmd = client.send.mock.calls[0]?.[0] as SendEmailCommand;
    expect(cmd).toBeInstanceOf(SendEmailCommand);
    expect(cmd.input.Source).toBe('agent@example.com');
    expect(cmd.input.Destination?.ToAddresses).toEqual(['dev@example.com']);
  });

  it('payload contains metadata fields and no code/diff/PII', async () => {
    const client = makeMockClient();
    const channel = createSesChannel({ from: 'agent@example.com', to: ['r@example.com'], client });
    await channel.send(baseEvent);
    const cmd = client.send.mock.calls[0]?.[0] as SendEmailCommand;
    const body = cmd.input.Message?.Body?.Text?.Data ?? '';
    const subject = cmd.input.Message?.Subject?.Data ?? '';
    expect(subject).toContain('review.completed');
    expect(subject).toContain('owner/repo');
    expect(body).toContain('job-ses');
    expect(body).toContain('PR number: #11');
    expect(body).toContain('Review completed');
    // Must not contain raw code/diff markers
    expect(body).not.toMatch(/^diff --git/m);
    expect(body).not.toMatch(/^@@/m);
  });

  it('omits prNumber from subject/body when undefined', async () => {
    const client = makeMockClient();
    const channel = createSesChannel({ from: 'a@e.com', to: ['r@e.com'], client });
    await channel.send({ ...baseEvent, prNumber: undefined });
    const cmd = client.send.mock.calls[0]?.[0] as SendEmailCommand;
    const subject = cmd.input.Message?.Subject?.Data ?? '';
    const body = cmd.input.Message?.Body?.Text?.Data ?? '';
    expect(subject).not.toContain('PR #');
    expect(body).not.toContain('PR number:');
  });

  it('reports name as "ses"', () => {
    const channel = createSesChannel({
      from: 'a@e.com',
      to: ['r@e.com'],
      client: makeMockClient(),
    });
    expect(channel.name).toBe('ses');
  });
});
