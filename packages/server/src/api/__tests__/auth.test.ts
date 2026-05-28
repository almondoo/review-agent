import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { bearerTokenAuth } from '../middleware/auth.js';

function makeApp(token: string | undefined, requireAuth: boolean) {
  const app = new Hono();
  app.use('*', bearerTokenAuth({ token, requireAuth }));
  app.get('/test', (c) => c.json({ ok: true }, 200));
  app.on('OPTIONS', '/test', (c) => c.json({ ok: true }, 200));
  return app;
}

describe('bearerTokenAuth', () => {
  describe('token unset + requireAuth=false (pass-through)', () => {
    it('returns 200 for GET requests', async () => {
      const app = makeApp(undefined, false);
      const res = await app.request('http://host/test');
      expect(res.status).toBe(200);
    });

    it('returns 200 for empty-string token (treated as unset)', async () => {
      const app = makeApp('', false);
      const res = await app.request('http://host/test');
      expect(res.status).toBe(200);
    });
  });

  describe('token unset + requireAuth=true (misconfiguration guard)', () => {
    it('returns 503 for any request when token is undefined', async () => {
      const app = makeApp(undefined, true);
      const res = await app.request('http://host/test');
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body).toEqual({ error: 'dashboard authentication not configured' });
    });

    it('returns 503 for any request when token is empty string', async () => {
      const app = makeApp('', true);
      const res = await app.request('http://host/test');
      expect(res.status).toBe(503);
    });
  });

  describe('token configured', () => {
    const TOKEN = 'super-secret-token-abc123';

    it('returns 200 when Authorization header has correct Bearer token', async () => {
      const app = makeApp(TOKEN, false);
      const res = await app.request('http://host/test', {
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      expect(res.status).toBe(200);
    });

    it('returns 401 when Authorization header is absent', async () => {
      const app = makeApp(TOKEN, false);
      const res = await app.request('http://host/test');
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body).toEqual({ error: 'unauthorized' });
    });

    it('returns 401 when Authorization uses Basic scheme instead of Bearer', async () => {
      const app = makeApp(TOKEN, false);
      const res = await app.request('http://host/test', {
        headers: { Authorization: `Basic ${TOKEN}` },
      });
      expect(res.status).toBe(401);
    });

    it('returns 401 when Bearer value has different length (timing-safe path)', async () => {
      const app = makeApp(TOKEN, false);
      const res = await app.request('http://host/test', {
        headers: { Authorization: 'Bearer short' },
      });
      expect(res.status).toBe(401);
    });

    it('returns 401 when Bearer value has same length but different content', async () => {
      const app = makeApp(TOKEN, false);
      // Same length as TOKEN ('super-secret-token-abc123' = 25 chars)
      const sameLength = 'x'.repeat(TOKEN.length);
      const res = await app.request('http://host/test', {
        headers: { Authorization: `Bearer ${sameLength}` },
      });
      expect(res.status).toBe(401);
    });

    it('returns 401 when Bearer value is longer than configured token', async () => {
      const app = makeApp(TOKEN, false);
      const longer = `${TOKEN}extra`;
      const res = await app.request('http://host/test', {
        headers: { Authorization: `Bearer ${longer}` },
      });
      expect(res.status).toBe(401);
    });
  });

  describe('OPTIONS preflight pass-through', () => {
    it('passes OPTIONS through when token is configured (CORS preflight)', async () => {
      const app = makeApp('my-token', false);
      // No Authorization header — OPTIONS must still pass through
      const res = await app.request('http://host/test', { method: 'OPTIONS' });
      expect(res.status).toBe(200);
    });

    it('passes OPTIONS through when requireAuth=true and token is unset', async () => {
      const app = makeApp(undefined, true);
      const res = await app.request('http://host/test', { method: 'OPTIONS' });
      expect(res.status).toBe(200);
    });

    it('passes OPTIONS through when token is unset and requireAuth=false', async () => {
      const app = makeApp(undefined, false);
      const res = await app.request('http://host/test', { method: 'OPTIONS' });
      expect(res.status).toBe(200);
    });
  });
});
