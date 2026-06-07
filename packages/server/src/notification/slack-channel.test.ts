import { describe, expect, it, vi } from 'vitest';
import { createSlackChannel } from './slack-channel.js';
import type { NotificationEvent } from './types.js';

const baseEvent: NotificationEvent = {
  type: 'job.failed',
  repo: 'owner/repo',
  installationId: '123',
  jobId: 'job-abc',
  timestamp: '2026-06-04T00:00:00.000Z',
  prNumber: 42,
  summary: 'Job failed: cost cap exceeded',
};

describe('createSlackChannel', () => {
  it('POSTs to the webhook URL with JSON content-type', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const channel = createSlackChannel({ webhookUrl: 'https://hooks.slack.com/T/B/X', fetchFn });
    await channel.send(baseEvent);
    expect(fetchFn).toHaveBeenCalledOnce();
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://hooks.slack.com/T/B/X');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  it('payload contains metadata fields and no code/diff/PII', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const channel = createSlackChannel({ webhookUrl: 'https://hooks.slack.com/T/B/X', fetchFn });
    await channel.send(baseEvent);
    const body = JSON.parse((fetchFn.mock.calls[0] as [string, RequestInit])[1].body as string) as {
      text: string;
    };
    expect(body.text).toContain('job.failed');
    expect(body.text).toContain('owner/repo');
    expect(body.text).toContain('job-abc');
    expect(body.text).toContain('PR #42');
    expect(body.text).toContain('Job failed: cost cap exceeded');
    // Must not contain raw code/diff markers
    expect(body.text).not.toMatch(/^diff --git/m);
    expect(body.text).not.toMatch(/^@@/m);
  });

  it('includes prNumber when present', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const channel = createSlackChannel({ webhookUrl: 'https://hooks.slack.com/T/B/X', fetchFn });
    await channel.send({ ...baseEvent, prNumber: 7 });
    const body = JSON.parse((fetchFn.mock.calls[0] as [string, RequestInit])[1].body as string) as {
      text: string;
    };
    expect(body.text).toContain('PR #7');
  });

  it('omits prNumber segment when undefined', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const channel = createSlackChannel({ webhookUrl: 'https://hooks.slack.com/T/B/X', fetchFn });
    await channel.send({ ...baseEvent, prNumber: undefined });
    const body = JSON.parse((fetchFn.mock.calls[0] as [string, RequestInit])[1].body as string) as {
      text: string;
    };
    expect(body.text).not.toContain('PR #');
  });

  it('throws when webhook returns non-ok status', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: false, status: 400 });
    const channel = createSlackChannel({ webhookUrl: 'https://hooks.slack.com/T/B/X', fetchFn });
    await expect(channel.send(baseEvent)).rejects.toThrow('400');
  });

  it('reports name as "slack"', () => {
    const channel = createSlackChannel({
      webhookUrl: 'https://hooks.slack.com/T/B/X',
      fetchFn: vi.fn(),
    });
    expect(channel.name).toBe('slack');
  });
});
