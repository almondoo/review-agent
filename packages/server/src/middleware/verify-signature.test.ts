import crypto from 'node:crypto';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { type VerifyEnv, verifyGithubSignature } from './verify-signature.js';

const SECRET = 'test-secret';

function buildApp() {
  const app = new Hono<VerifyEnv>();
  app.post('/hook', verifyGithubSignature(SECRET), (c) =>
    c.json({ ok: true, raw: c.get('rawBody'), parsed: c.get('parsedBody') }),
  );
  return app;
}

function sign(body: string, secret: string): string {
  return `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
}

describe('verifyGithubSignature', () => {
  it('rejects with 401 when signature header missing', async () => {
    const res = await buildApp().request('/hook', { method: 'POST', body: '{}' });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
  });

  it('rejects with 401 when signature mismatches', async () => {
    const res = await buildApp().request('/hook', {
      method: 'POST',
      headers: { 'x-hub-signature-256': 'sha256=deadbeef', 'content-type': 'application/json' },
      body: '{"a":1}',
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
  });

  it('returns identical 401 body for missing vs invalid (no leak)', async () => {
    const a = await buildApp().request('/hook', { method: 'POST', body: '{}' });
    const b = await buildApp().request('/hook', {
      method: 'POST',
      headers: { 'x-hub-signature-256': 'sha256=00' },
      body: '{}',
    });
    expect(await a.text()).toBe(await b.text());
  });

  it('accepts valid signature and forwards parsed body', async () => {
    const body = JSON.stringify({ event: 'pong' });
    const res = await buildApp().request('/hook', {
      method: 'POST',
      headers: { 'x-hub-signature-256': sign(body, SECRET), 'content-type': 'application/json' },
      body,
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; raw: string; parsed: { event: string } };
    expect(json.ok).toBe(true);
    expect(json.raw).toBe(body);
    expect(json.parsed.event).toBe('pong');
  });

  it('rejects malformed JSON with 400 even when signature is valid', async () => {
    const body = 'not-json';
    const res = await buildApp().request('/hook', {
      method: 'POST',
      headers: { 'x-hub-signature-256': sign(body, SECRET) },
      body,
    });
    expect(res.status).toBe(400);
  });

  it('rejects when signature length differs (length-fast-path before timingSafeEqual)', async () => {
    const body = '{}';
    const wrong = `sha256=${crypto.createHmac('sha256', SECRET).update(body).digest('hex').slice(0, 10)}`;
    const res = await buildApp().request('/hook', {
      method: 'POST',
      headers: { 'x-hub-signature-256': wrong },
      body,
    });
    expect(res.status).toBe(401);
  });

  it('rejects when signature has the right length but a wrong byte (timingSafeEqual path)', async () => {
    // The previous test only exercises `a.length !== b.length`. This one
    // forces the actual `timingSafeEqual` branch by submitting a 64-hex
    // signature with the same shape as a real one but a single flipped char.
    const body = '{}';
    const real = sign(body, SECRET); // sha256=<64 hex>
    const flipped = `${real.slice(0, -1)}${real.endsWith('a') ? 'b' : 'a'}`;
    expect(flipped.length).toBe(real.length);
    expect(flipped).not.toBe(real);
    const res = await buildApp().request('/hook', {
      method: 'POST',
      headers: { 'x-hub-signature-256': flipped },
      body,
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
  });

  it('rejects an empty signature header value', async () => {
    // The implementation treats falsy headers via `if (!sig)` (line 14).
    // Many proxies normalize a missing header into an empty string, so we
    // pin both behaviors as equivalent.
    const res = await buildApp().request('/hook', {
      method: 'POST',
      headers: { 'x-hub-signature-256': '' },
      body: '{}',
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
  });

  it('rejects a signature missing the sha256= prefix even if the digest is valid', async () => {
    const body = '{}';
    const realDigest = crypto.createHmac('sha256', SECRET).update(body).digest('hex');
    const res = await buildApp().request('/hook', {
      method: 'POST',
      headers: { 'x-hub-signature-256': realDigest }, // no 'sha256=' prefix
      body,
    });
    expect(res.status).toBe(401);
  });
});
