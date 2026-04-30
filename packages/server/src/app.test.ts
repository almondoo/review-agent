import crypto from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from './app.js';

const SECRET = 'sec';

function makeDb() {
  const seen = new Set<string>();
  return {
    seen,
    insert: () => ({
      values: (v: { deliveryId: string }) => ({
        onConflictDoNothing: () => ({
          returning: async () => {
            if (seen.has(v.deliveryId)) return [];
            seen.add(v.deliveryId);
            return [{ deliveryId: v.deliveryId }];
          },
        }),
      }),
    }),
  };
}

function sign(body: string): string {
  return `sha256=${crypto.createHmac('sha256', SECRET).update(body).digest('hex')}`;
}

describe('createApp', () => {
  it('exposes /healthz', async () => {
    const app = createApp({
      // biome-ignore lint/suspicious/noExplicitAny: mock
      db: makeDb() as any,
      queue: { enqueue: vi.fn(), dequeue: vi.fn() },
      webhookSecret: SECRET,
    });
    const res = await app.request('/healthz');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('end-to-end: signed pull_request.opened enqueues a job', async () => {
    const enqueue = vi.fn().mockResolvedValue({ messageId: 'm-7' });
    const app = createApp({
      // biome-ignore lint/suspicious/noExplicitAny: mock
      db: makeDb() as any,
      queue: { enqueue, dequeue: vi.fn() },
      webhookSecret: SECRET,
      now: () => new Date('2026-04-30T00:00:00Z'),
    });
    const body = JSON.stringify({
      action: 'opened',
      installation: { id: 1 },
      repository: { owner: { login: 'o' }, name: 'r' },
      pull_request: { number: 7, draft: false, head: { sha: 'abc1234' } },
    });
    const res = await app.request('/webhook', {
      method: 'POST',
      headers: {
        'x-hub-signature-256': sign(body),
        'x-github-event': 'pull_request',
        'x-github-delivery': 'dlv-100',
        'content-type': 'application/json',
      },
      body,
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { kind: string };
    expect(json.kind).toBe('enqueued');
    expect(enqueue).toHaveBeenCalledOnce();
  });

  it('rejects bad signature with 401', async () => {
    const app = createApp({
      // biome-ignore lint/suspicious/noExplicitAny: mock
      db: makeDb() as any,
      queue: { enqueue: vi.fn(), dequeue: vi.fn() },
      webhookSecret: SECRET,
    });
    const res = await app.request('/webhook', {
      method: 'POST',
      headers: { 'x-hub-signature-256': 'sha256=00', 'x-github-event': 'ping' },
      body: '{}',
    });
    expect(res.status).toBe(401);
  });

  it('returns deduped on second delivery with same X-GitHub-Delivery', async () => {
    const db = makeDb();
    const enqueue = vi.fn().mockResolvedValue({ messageId: 'm-1' });
    const app = createApp({
      // biome-ignore lint/suspicious/noExplicitAny: mock
      db: db as any,
      queue: { enqueue, dequeue: vi.fn() },
      webhookSecret: SECRET,
    });
    const body = JSON.stringify({ zen: 'ping', hook_id: 1 });
    const reqInit = {
      method: 'POST' as const,
      headers: {
        'x-hub-signature-256': sign(body),
        'x-github-event': 'ping',
        'x-github-delivery': 'dlv-200',
        'content-type': 'application/json',
      },
      body,
    };
    const r1 = await app.request('/webhook', reqInit);
    expect(r1.status).toBe(200);
    const r2 = await app.request('/webhook', reqInit);
    expect(r2.status).toBe(200);
    expect(await r2.json()).toEqual({ deduped: true });
  });
});
