import crypto from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from './app.js';

const SECRET = 'sec';
const TOPIC = 'arn:aws:sns:us-east-1:111111111111:t';
const ACCOUNT = '111111111111';

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

function snsBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    Type: 'Notification',
    MessageId: 'sns-msg-1',
    TopicArn: TOPIC,
    Timestamp: '2026-04-30T00:00:00Z',
    Signature: 'sig',
    SignatureVersion: '2',
    SigningCertURL: 'https://sns.us-east-1.amazonaws.com/cert.pem',
    Message: JSON.stringify({
      source: 'aws.codecommit',
      account: ACCOUNT,
      detail: {
        event: 'pullRequestCreated',
        pullRequestId: '1',
        repositoryName: 'r',
        sourceCommit: 'abc1234',
      },
    }),
    ...overrides,
  });
}

describe('createApp', () => {
  it('exposes /healthz', async () => {
    const app = createApp({
      // biome-ignore lint/suspicious/noExplicitAny: mock
      db: makeDb() as any,
      queue: { enqueue: vi.fn(), dequeue: vi.fn() },
      webhookSecret: SECRET,
      allowedSnsTopicArns: [TOPIC],
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
      allowedSnsTopicArns: [TOPIC],
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
      allowedSnsTopicArns: [TOPIC],
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
      allowedSnsTopicArns: [TOPIC],
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

  describe('SEC-1: /webhook/codecommit fail-closed on missing allowlist', () => {
    it('rejects with 403 when no allowlist is configured', async () => {
      const app = createApp({
        // biome-ignore lint/suspicious/noExplicitAny: mock
        db: makeDb() as any,
        queue: { enqueue: vi.fn(), dequeue: vi.fn() },
        webhookSecret: SECRET,
        sns: { fetchCert: async () => 'PEM', verifySignature: () => true },
      });
      const res = await app.request('/webhook/codecommit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: snsBody(),
      });
      expect(res.status).toBe(403);
    });

    it('rejects with 403 when TopicArn is not on the allowlist', async () => {
      const app = createApp({
        // biome-ignore lint/suspicious/noExplicitAny: mock
        db: makeDb() as any,
        queue: { enqueue: vi.fn(), dequeue: vi.fn() },
        webhookSecret: SECRET,
        sns: { fetchCert: async () => 'PEM', verifySignature: () => true },
        allowedSnsTopicArns: ['arn:aws:sns:us-east-1:111111111111:other'],
      });
      const res = await app.request('/webhook/codecommit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: snsBody(),
      });
      expect(res.status).toBe(403);
    });

    it('rejects with 403 for off-allowlist SubscriptionConfirmation (control-bypass path)', async () => {
      const app = createApp({
        // biome-ignore lint/suspicious/noExplicitAny: mock
        db: makeDb() as any,
        queue: { enqueue: vi.fn(), dequeue: vi.fn() },
        webhookSecret: SECRET,
        sns: { fetchCert: async () => 'PEM', verifySignature: () => true },
        allowedSnsTopicArns: ['arn:aws:sns:us-east-1:111111111111:other'],
      });
      const sub = JSON.stringify({
        Type: 'SubscriptionConfirmation',
        MessageId: 'm-x',
        TopicArn: TOPIC,
        Timestamp: '2026-04-30T00:00:00Z',
        Signature: 'sig',
        SignatureVersion: '2',
        SigningCertURL: 'https://sns.us-east-1.amazonaws.com/cert.pem',
        SubscribeURL: 'https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&Token=t',
        Message: 'You have chosen to subscribe',
      });
      const res = await app.request('/webhook/codecommit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: sub,
      });
      expect(res.status).toBe(403);
    });

    it('reads REVIEW_AGENT_SNS_TOPIC_ARNS from env when allowedSnsTopicArns is not passed', async () => {
      const prev = process.env.REVIEW_AGENT_SNS_TOPIC_ARNS;
      process.env.REVIEW_AGENT_SNS_TOPIC_ARNS = `${TOPIC}, arn:aws:sns:us-east-1:111111111111:b`;
      try {
        const enqueue = vi.fn().mockResolvedValue({ messageId: 'm-cc' });
        const app = createApp({
          // biome-ignore lint/suspicious/noExplicitAny: mock
          db: makeDb() as any,
          queue: { enqueue, dequeue: vi.fn() },
          webhookSecret: SECRET,
          sns: { fetchCert: async () => 'PEM', verifySignature: () => true },
        });
        const res = await app.request('/webhook/codecommit', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: snsBody(),
        });
        expect(res.status).toBe(200);
        expect(enqueue).toHaveBeenCalledOnce();
      } finally {
        if (prev === undefined) delete process.env.REVIEW_AGENT_SNS_TOPIC_ARNS;
        else process.env.REVIEW_AGENT_SNS_TOPIC_ARNS = prev;
      }
    });
  });

  describe('SEC-3: namespaced delivery ids', () => {
    it('persists the SNS MessageId as sns:<id> in the dedup table', async () => {
      const db = makeDb();
      const enqueue = vi.fn().mockResolvedValue({ messageId: 'm-cc' });
      const app = createApp({
        // biome-ignore lint/suspicious/noExplicitAny: mock
        db: db as any,
        queue: { enqueue, dequeue: vi.fn() },
        webhookSecret: SECRET,
        sns: { fetchCert: async () => 'PEM', verifySignature: () => true },
        allowedSnsTopicArns: [TOPIC],
      });
      const res = await app.request('/webhook/codecommit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: snsBody({ MessageId: 'abc' }),
      });
      expect(res.status).toBe(200);
      expect(db.seen.has('sns:abc')).toBe(true);
      expect(db.seen.has('abc')).toBe(false);
    });

    it('does not collide between a GitHub delivery id and an identical SNS MessageId', async () => {
      const db = makeDb();
      const enqueue = vi.fn().mockResolvedValue({ messageId: 'm' });
      const app = createApp({
        // biome-ignore lint/suspicious/noExplicitAny: mock
        db: db as any,
        queue: { enqueue, dequeue: vi.fn() },
        webhookSecret: SECRET,
        sns: { fetchCert: async () => 'PEM', verifySignature: () => true },
        allowedSnsTopicArns: [TOPIC],
      });
      const ghBody = JSON.stringify({ zen: 'ping', hook_id: 1 });
      const ghRes = await app.request('/webhook', {
        method: 'POST',
        headers: {
          'x-hub-signature-256': sign(ghBody),
          'x-github-event': 'ping',
          'x-github-delivery': 'shared-uuid',
          'content-type': 'application/json',
        },
        body: ghBody,
      });
      expect(ghRes.status).toBe(200);
      // Same UUID for the SNS MessageId should *not* be deduped: the
      // codecommit bridge writes `sns:shared-uuid`, not `shared-uuid`.
      const snsRes = await app.request('/webhook/codecommit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: snsBody({ MessageId: 'shared-uuid' }),
      });
      expect(snsRes.status).toBe(200);
      const json = (await snsRes.json()) as { kind: string };
      expect(json.kind).toBe('enqueued');
    });
  });

  describe('SEC-8: SubscriptionConfirmation bypasses idempotency', () => {
    it('processes a re-delivered SubscriptionConfirmation a second time', async () => {
      const db = makeDb();
      const confirmFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
      const app = createApp({
        // biome-ignore lint/suspicious/noExplicitAny: mock
        db: db as any,
        queue: { enqueue: vi.fn(), dequeue: vi.fn() },
        webhookSecret: SECRET,
        sns: { fetchCert: async () => 'PEM', verifySignature: () => true },
        allowedSnsTopicArns: [TOPIC],
      });
      // Pre-seed the dedup table with `sns:retry` so a subsequent
      // Notification with that MessageId would dedup. SubscriptionConfirmation
      // re-deliveries must *not* be affected — the operator needs every
      // confirmation retry to actually run the confirm path.
      db.seen.add('sns:retry');

      // Patch global fetch so the handler's default SubscribeURL GET
      // path is not exercised; we use the dep-injected
      // `confirmFetch` only inside the handler.
      const sub = JSON.stringify({
        Type: 'SubscriptionConfirmation',
        MessageId: 'retry',
        TopicArn: TOPIC,
        Timestamp: '2026-04-30T00:00:00Z',
        Signature: 'sig',
        SignatureVersion: '2',
        SigningCertURL: 'https://sns.us-east-1.amazonaws.com/cert.pem',
        Token: 'tok',
        SubscribeURL: 'https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&Token=tok',
        Message: 'You have chosen to subscribe',
      });
      // Replace global fetch for the duration of the call so the
      // handler's default SubscribeURL fetch is captured (we did not
      // wire a dep override through createApp).
      const origFetch = globalThis.fetch;
      globalThis.fetch = confirmFetch as unknown as typeof fetch;
      try {
        const r1 = await app.request('/webhook/codecommit', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: sub,
        });
        expect(r1.status).toBe(200);
        const r2 = await app.request('/webhook/codecommit', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: sub,
        });
        expect(r2.status).toBe(200);
        // Both calls must have hit the SubscribeURL — no silent dedup.
        expect(confirmFetch).toHaveBeenCalledTimes(2);
      } finally {
        globalThis.fetch = origFetch;
      }
    });
  });
});
