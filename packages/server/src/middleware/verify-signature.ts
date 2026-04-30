import crypto from 'node:crypto';
import { createMiddleware } from 'hono/factory';

export type VerifyEnv = {
  Variables: {
    rawBody: string;
    parsedBody: unknown;
  };
};

export function verifyGithubSignature(secret: string) {
  return createMiddleware<VerifyEnv>(async (c, next) => {
    const sig = c.req.header('x-hub-signature-256');
    if (!sig) return c.json({ error: 'unauthorized' }, 401);
    const raw = await c.req.text();
    const hmac = crypto.createHmac('sha256', secret);
    const expected = `sha256=${hmac.update(raw).digest('hex')}`;
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    c.set('rawBody', raw);
    try {
      c.set('parsedBody', JSON.parse(raw));
    } catch {
      return c.json({ error: 'bad request' }, 400);
    }
    await next();
  });
}
