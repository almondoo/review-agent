import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { devCors } from '../middleware/cors.js';

describe('devCors middleware', () => {
  function makeApp(env: Record<string, string | undefined>) {
    const app = new Hono();
    app.use('/*', devCors(env));
    app.get('/test', (c) => c.json({ ok: true }));
    return app;
  }

  it('does not add CORS headers when REVIEW_AGENT_DASHBOARD_CORS is unset', async () => {
    const app = makeApp({});
    const res = await app.request('http://localhost:5173/test', {
      headers: { Origin: 'http://localhost:5173' },
    });
    // With empty origin array, hono/cors won't match — no ACAO header
    expect(res.headers.get('access-control-allow-origin')).toBe(null);
  });

  it('does not add CORS headers when REVIEW_AGENT_DASHBOARD_CORS=0', async () => {
    const app = makeApp({ REVIEW_AGENT_DASHBOARD_CORS: '0' });
    const res = await app.request('http://localhost:5173/test', {
      headers: { Origin: 'http://localhost:5173' },
    });
    expect(res.headers.get('access-control-allow-origin')).toBe(null);
  });

  it('adds CORS header for localhost:5173 when REVIEW_AGENT_DASHBOARD_CORS=1', async () => {
    const app = makeApp({ REVIEW_AGENT_DASHBOARD_CORS: '1' });
    const res = await app.request('http://localhost:5173/test', {
      headers: { Origin: 'http://localhost:5173' },
    });
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
  });

  it('handles preflight OPTIONS request with CORS enabled', async () => {
    const app = makeApp({ REVIEW_AGENT_DASHBOARD_CORS: '1' });
    const res = await app.request('http://localhost:5173/test', {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://localhost:5173',
        'Access-Control-Request-Method': 'POST',
      },
    });
    // Should have Allow-Methods in the response
    expect(res.status).toBe(204);
  });

  it('OPTIONS preflight reaches the route handler when CORS disabled (no swallowing)', async () => {
    // When disabled the no-op must call next() so OPTIONS is handled by the
    // route layer, not absorbed and returned as 204.
    const app = new Hono();
    app.use('/*', devCors({}));
    // Explicit OPTIONS handler so we can observe it was reached
    app.on('OPTIONS', '/test', (c) => c.text('reached', 200));
    const res = await app.request('http://localhost:5173/test', {
      method: 'OPTIONS',
      headers: { Origin: 'http://localhost:5173' },
    });
    // Route handler must have been called (not absorbed by cors middleware)
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('reached');
  });
});
