import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { idempotency } from './idempotency.js';

type SeenSet = Set<string>;

function makeMockDb(seen: SeenSet) {
  return {
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

function buildApp(seen: SeenSet) {
  const app = new Hono();
  // biome-ignore lint/suspicious/noExplicitAny: mock surface
  app.post('/hook', idempotency({ db: makeMockDb(seen) as any }), (c) => c.json({ ok: true }));
  return app;
}

describe('idempotency middleware', () => {
  it('returns 400 when X-GitHub-Delivery header missing', async () => {
    const seen = new Set<string>();
    const res = await buildApp(seen).request('/hook', { method: 'POST' });
    expect(res.status).toBe(400);
  });

  it('passes through on first delivery', async () => {
    const seen = new Set<string>();
    const res = await buildApp(seen).request('/hook', {
      method: 'POST',
      headers: { 'x-github-delivery': 'dlv-1' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(seen.has('dlv-1')).toBe(true);
  });

  it('returns deduped:true on duplicate delivery', async () => {
    const seen = new Set<string>(['dlv-2']);
    const res = await buildApp(seen).request('/hook', {
      method: 'POST',
      headers: { 'x-github-delivery': 'dlv-2' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deduped: true });
  });
});
