import crypto from 'node:crypto';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import {
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

  it('rejects a cert URL not under amazonaws.com', async () => {
    const ok = await verifySnsMessage({
      ...makeNotification(),
      SigningCertURL: 'https://evil.example.com/cert.pem',
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

    // And a tampered canonical string fails.
    const tampered: SnsMessage = { ...signed, Message: 'tampered' };
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
