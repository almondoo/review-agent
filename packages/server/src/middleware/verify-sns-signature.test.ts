import crypto from 'node:crypto';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _clearSnsCertCache,
  buildSnsCanonicalString,
  type SnsMessage,
  type VerifySnsEnv,
  verifySnsMessage,
  verifySnsSignature,
} from './verify-sns-signature.js';

function makeNotification(overrides: Partial<SnsMessage> = {}): SnsMessage {
  return {
    Type: 'Notification',
    MessageId: 'mid-1',
    TopicArn: 'arn:aws:sns:us-east-1:111111111111:t',
    Subject: 's',
    Message: 'm',
    Timestamp: '2026-04-30T00:00:00Z',
    SignatureVersion: '2',
    Signature: 'AAAA',
    SigningCertURL: 'https://sns.us-east-1.amazonaws.com/cert.pem',
    ...overrides,
  };
}

function makeSubscriptionConfirmation(overrides: Partial<SnsMessage> = {}): SnsMessage {
  return {
    Type: 'SubscriptionConfirmation',
    MessageId: 'mid-2',
    TopicArn: 'arn:aws:sns:us-east-1:111111111111:t',
    Message: 'You have chosen to subscribe',
    Token: 'tok-abc',
    SubscribeURL: 'https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&Token=tok-abc',
    Timestamp: '2026-04-30T00:00:00Z',
    SignatureVersion: '2',
    Signature: 'BBBB',
    SigningCertURL: 'https://sns.us-east-1.amazonaws.com/cert.pem',
    ...overrides,
  };
}

beforeEach(() => {
  _clearSnsCertCache();
});

afterEach(() => {
  _clearSnsCertCache();
});

describe('buildSnsCanonicalString', () => {
  it('produces the documented canonical string for a Notification with Subject', () => {
    const msg = makeNotification();
    const got = buildSnsCanonicalString(msg);
    expect(got).toBe(
      'Message\nm\nMessageId\nmid-1\nSubject\ns\nTimestamp\n2026-04-30T00:00:00Z\nTopicArn\narn:aws:sns:us-east-1:111111111111:t\nType\nNotification\n',
    );
  });

  it('omits Subject when absent', () => {
    const { Subject: _subject, ...rest } = makeNotification();
    const msg = rest as SnsMessage;
    const got = buildSnsCanonicalString(msg);
    expect(got).not.toContain('Subject');
    expect(got).toContain('Type\nNotification\n');
  });

  it('produces the documented canonical string for SubscriptionConfirmation', () => {
    const msg = makeSubscriptionConfirmation();
    const got = buildSnsCanonicalString(msg);
    expect(got).toContain('SubscribeURL\nhttps://');
    expect(got).toContain('Token\ntok-abc\n');
    expect(got).toContain('Type\nSubscriptionConfirmation\n');
  });
});

describe('verifySnsMessage', () => {
  it('returns false for unknown SignatureVersion', async () => {
    const ok = await verifySnsMessage({
      ...makeNotification(),
      // biome-ignore lint/suspicious/noExplicitAny: deliberate bad version
      SignatureVersion: '99' as any,
    });
    expect(ok).toBe(false);
  });

  it('rejects a cert URL not under sns.<region>.amazonaws.com (SEC-7)', async () => {
    const ok = await verifySnsMessage({
      ...makeNotification(),
      SigningCertURL: 'https://evil.example.com/cert.pem',
    });
    expect(ok).toBe(false);
  });

  it('rejects a cert URL on a non-sns AWS host (SEC-7 tightening)', async () => {
    // The pre-fix code accepted any `*.amazonaws.com` host. After
    // tightening to `sns.<region>.amazonaws.com`, `s3.amazonaws.com`
    // (or any other AWS service host) must be rejected.
    const ok = await verifySnsMessage({
      ...makeNotification(),
      SigningCertURL: 'https://s3.amazonaws.com/some-bucket/cert.pem',
    });
    expect(ok).toBe(false);
  });

  it('rejects an http (non-https) cert URL', async () => {
    const ok = await verifySnsMessage({
      ...makeNotification(),
      SigningCertURL: 'http://sns.us-east-1.amazonaws.com/cert.pem',
    });
    expect(ok).toBe(false);
  });

  it('rejects a syntactically invalid cert URL', async () => {
    const ok = await verifySnsMessage({
      ...makeNotification(),
      SigningCertURL: 'not a url',
    });
    expect(ok).toBe(false);
  });

  it('passes the canonical string and base64 signature through to the verifier', async () => {
    const verifier = vi.fn().mockReturnValue(true);
    const ok = await verifySnsMessage(makeNotification(), {
      fetchCert: async () => 'PEM',
      verifySignature: verifier,
    });
    expect(ok).toBe(true);
    const call = verifier.mock.calls[0]?.[0];
    expect(call.certificatePem).toBe('PEM');
    expect(call.signatureBase64).toBe('AAAA');
    expect(call.signatureVersion).toBe('2');
    expect(call.canonical).toContain('Type\nNotification\n');
  });

  it('returns false when the injected verifier rejects', async () => {
    const ok = await verifySnsMessage(makeNotification(), {
      fetchCert: async () => 'PEM',
      verifySignature: () => false,
    });
    expect(ok).toBe(false);
  });

  it('uses a real RSA keypair end-to-end with the default verifier', async () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    // Produce a self-signed cert PEM from the key. For testing the
    // default verifier path we just need a public-key PEM since
    // `crypto.createVerify(...).verify()` accepts PEM-encoded public
    // keys as well as certificates.
    const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

    const msg = makeNotification();
    const canonical = buildSnsCanonicalString(msg);
    const signer = crypto.createSign('RSA-SHA256');
    signer.update(canonical, 'utf8');
    const signature = signer.sign(privateKey, 'base64');

    const signed: SnsMessage = { ...msg, Signature: signature };
    const ok = await verifySnsMessage(signed, {
      fetchCert: async () => publicPem,
      // omit verifySignature → exercises the default node:crypto path.
    });
    expect(ok).toBe(true);

    // And a tampered canonical string fails. Use a *different* cert
    // URL so the cache (populated by the first call) is not consulted.
    const tampered: SnsMessage = {
      ...signed,
      Message: 'tampered',
      SigningCertURL: 'https://sns.us-east-2.amazonaws.com/cert.pem',
    };
    const okBad = await verifySnsMessage(tampered, { fetchCert: async () => publicPem });
    expect(okBad).toBe(false);
  });

  it('returns false when fetchCert throws', async () => {
    const ok = await verifySnsMessage(makeNotification(), {
      fetchCert: async () => {
        throw new Error('boom');
      },
    }).catch(() => false);
    expect(ok).toBe(false);
  });

  describe('cert cache (SEC-2)', () => {
    it('serves a cached PEM on the second verification with the same URL', async () => {
      const fetchCert = vi.fn().mockResolvedValue('PEM');
      const verifier = vi.fn().mockReturnValue(true);
      const msg = makeNotification();

      await verifySnsMessage(msg, { fetchCert, verifySignature: verifier });
      await verifySnsMessage(msg, { fetchCert, verifySignature: verifier });

      expect(fetchCert).toHaveBeenCalledTimes(1);
      expect(verifier).toHaveBeenCalledTimes(2);
    });

    it('caches independently per SigningCertURL', async () => {
      const fetchCert = vi.fn().mockResolvedValue('PEM');
      const verifier = vi.fn().mockReturnValue(true);
      const a = makeNotification({
        SigningCertURL: 'https://sns.us-east-1.amazonaws.com/cert-a.pem',
      });
      const b = makeNotification({
        SigningCertURL: 'https://sns.us-east-2.amazonaws.com/cert-b.pem',
      });

      await verifySnsMessage(a, { fetchCert, verifySignature: verifier });
      await verifySnsMessage(b, { fetchCert, verifySignature: verifier });
      await verifySnsMessage(a, { fetchCert, verifySignature: verifier });

      expect(fetchCert).toHaveBeenCalledTimes(2);
    });

    it('re-fetches after TTL expires (24h)', async () => {
      vi.useFakeTimers();
      try {
        const fetchCert = vi.fn().mockResolvedValue('PEM');
        const verifier = vi.fn().mockReturnValue(true);
        const msg = makeNotification();

        await verifySnsMessage(msg, { fetchCert, verifySignature: verifier });
        // Advance 24h + 1 ms — entry should be expired.
        vi.setSystemTime(Date.now() + 24 * 60 * 60 * 1_000 + 1);
        await verifySnsMessage(msg, { fetchCert, verifySignature: verifier });

        expect(fetchCert).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it('evicts the oldest entry past the LRU bound', async () => {
      const fetchCert = vi.fn().mockResolvedValue('PEM');
      const verifier = vi.fn().mockReturnValue(true);

      // Fill cache with 64 distinct URLs.
      for (let i = 0; i < 64; i++) {
        await verifySnsMessage(
          makeNotification({
            SigningCertURL: `https://sns.us-east-1.amazonaws.com/cert-${i}.pem`,
          }),
          { fetchCert, verifySignature: verifier },
        );
      }
      expect(fetchCert).toHaveBeenCalledTimes(64);

      // 65th distinct URL should evict cert-0.
      await verifySnsMessage(
        makeNotification({
          SigningCertURL: 'https://sns.us-east-1.amazonaws.com/cert-99.pem',
        }),
        { fetchCert, verifySignature: verifier },
      );
      expect(fetchCert).toHaveBeenCalledTimes(65);

      // cert-0 should now miss and re-fetch.
      await verifySnsMessage(
        makeNotification({
          SigningCertURL: 'https://sns.us-east-1.amazonaws.com/cert-0.pem',
        }),
        { fetchCert, verifySignature: verifier },
      );
      expect(fetchCert).toHaveBeenCalledTimes(66);
    });
  });

  describe('default fetchCert timeout (SEC-2)', () => {
    it('passes an AbortSignal with a 5s timeout to fetch()', async () => {
      const mockFetch = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response('PEM', { status: 200 }));
      try {
        const ok = await verifySnsMessage(makeNotification(), {
          // omit fetchCert → exercises the default path.
          verifySignature: () => true,
        });
        expect(ok).toBe(true);
        const call = mockFetch.mock.calls[0];
        expect(call).toBeDefined();
        const init = call?.[1];
        expect(init).toBeDefined();
        expect(init?.signal).toBeInstanceOf(AbortSignal);
      } finally {
        mockFetch.mockRestore();
      }
    });

    it('returns false when the default fetch is aborted by an already-aborted signal', async () => {
      // Stub fetch to honour the AbortSignal — if it is already
      // aborted at call time, reject immediately. This avoids
      // sleeping for the real 5s timeout while still proving the
      // signal wires through end-to-end.
      const mockFetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
        const signal = (init as RequestInit | undefined)?.signal;
        if (signal?.aborted) throw new Error('aborted');
        return new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('aborted')));
        });
      });
      // Patch AbortSignal.timeout to return an already-aborted signal.
      const origTimeout = AbortSignal.timeout;
      AbortSignal.timeout = () => {
        const ctrl = new AbortController();
        ctrl.abort();
        return ctrl.signal;
      };
      try {
        const ok = await verifySnsMessage(
          {
            ...makeNotification(),
            SigningCertURL: 'https://sns.us-east-1.amazonaws.com/timeout.pem',
          },
          { verifySignature: () => true },
        ).catch(() => false);
        expect(ok).toBe(false);
      } finally {
        AbortSignal.timeout = origTimeout;
        mockFetch.mockRestore();
      }
    });
  });
});

function buildApp() {
  const app = new Hono<VerifySnsEnv>();
  app.post(
    '/sns',
    verifySnsSignature({
      fetchCert: async () => 'PEM',
      verifySignature: () => true,
    }),
    (c) => c.json({ ok: true, type: c.get('snsMessage').Type }),
  );
  return app;
}

describe('verifySnsSignature middleware', () => {
  it('accepts a valid Notification and exposes parsed message on context', async () => {
    const res = await buildApp().request('/sns', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(makeNotification()),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, type: 'Notification' });
  });

  it('rejects with 400 on malformed JSON', async () => {
    const res = await buildApp().request('/sns', { method: 'POST', body: 'not-json' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'bad request' });
  });

  it('rejects with 400 when required fields are missing', async () => {
    const res = await buildApp().request('/sns', {
      method: 'POST',
      body: JSON.stringify({ Type: 'Notification' }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects with 400 on unknown Type', async () => {
    const res = await buildApp().request('/sns', {
      method: 'POST',
      body: JSON.stringify({ ...makeNotification(), Type: 'Weird' }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects with 400 on bad SignatureVersion', async () => {
    const res = await buildApp().request('/sns', {
      method: 'POST',
      body: JSON.stringify({ ...makeNotification(), SignatureVersion: '7' }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects with 401 when the verifier returns false', async () => {
    const app = new Hono<VerifySnsEnv>();
    app.post(
      '/sns',
      verifySnsSignature({
        fetchCert: async () => 'PEM',
        verifySignature: () => false,
      }),
      (c) => c.json({ ok: true }),
    );
    const res = await app.request('/sns', {
      method: 'POST',
      body: JSON.stringify(makeNotification()),
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
  });

  it('rejects with 401 when verifier throws', async () => {
    const app = new Hono<VerifySnsEnv>();
    app.post(
      '/sns',
      verifySnsSignature({
        fetchCert: async () => 'PEM',
        verifySignature: () => {
          throw new Error('verify boom');
        },
      }),
      (c) => c.json({ ok: true }),
    );
    const res = await app.request('/sns', {
      method: 'POST',
      body: JSON.stringify(makeNotification()),
    });
    expect(res.status).toBe(401);
  });
});
