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

  describe('dashboardToken auth wiring', () => {
    it('passes /api requests through when token is passed via deps.api', async () => {
      const app = createApp({
        // biome-ignore lint/suspicious/noExplicitAny: mock
        db: makeDb() as any,
        queue: { enqueue: vi.fn(), dequeue: vi.fn() },
        webhookSecret: SECRET,
        allowedSnsTopicArns: [TOPIC],
        api: { dashboardToken: 'test-token', requireDashboardAuth: false },
      });
      const authed = await app.request('/api/integrations', {
        headers: { Authorization: 'Bearer test-token' },
      });
      expect(authed.status).toBe(200);
      const unauthed = await app.request('/api/integrations');
      expect(unauthed.status).toBe(401);
    });

    it('reads REVIEW_AGENT_DASHBOARD_TOKEN from env when deps.api.dashboardToken not set', async () => {
      const prev = process.env.REVIEW_AGENT_DASHBOARD_TOKEN;
      process.env.REVIEW_AGENT_DASHBOARD_TOKEN = 'env-token';
      try {
        const app = createApp({
          // biome-ignore lint/suspicious/noExplicitAny: mock
          db: makeDb() as any,
          queue: { enqueue: vi.fn(), dequeue: vi.fn() },
          webhookSecret: SECRET,
          allowedSnsTopicArns: [TOPIC],
        });
        const res = await app.request('/api/integrations', {
          headers: { Authorization: 'Bearer env-token' },
        });
        expect(res.status).toBe(200);
      } finally {
        if (prev === undefined) delete process.env.REVIEW_AGENT_DASHBOARD_TOKEN;
        else process.env.REVIEW_AGENT_DASHBOARD_TOKEN = prev;
      }
    });
  });

  it('apiEnv: REVIEW_AGENT_MODEL flows through to GET /api/integrations llm.model', async () => {
    const prev = process.env.REVIEW_AGENT_MODEL;
    process.env.REVIEW_AGENT_MODEL = 'custom-model-for-test';
    // Also set ANTHROPIC_API_KEY so the LLM integration shows configured=true
    const prevKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    try {
      const app = createApp({
        // biome-ignore lint/suspicious/noExplicitAny: mock
        db: makeDb() as any,
        queue: { enqueue: vi.fn(), dequeue: vi.fn() },
        webhookSecret: SECRET,
        allowedSnsTopicArns: [TOPIC],
      });
      const res = await app.request('/api/integrations');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.llm.model).toBe('custom-model-for-test');
    } finally {
      if (prev === undefined) delete process.env.REVIEW_AGENT_MODEL;
      else process.env.REVIEW_AGENT_MODEL = prev;
      if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prevKey;
    }
  });

  it('end-to-end: signed installation.created wires db through to handler and upserts', async () => {
    // Build a DB mock that handles both the idempotency middleware (outer
    // `insert` for webhook_deliveries) and the withTenant / installation
    // upsert path (inner `transaction` → `tx.execute` + `tx.insert`).
    const seen = new Set<string>();
    const txInsertResult = { onConflictDoUpdate: vi.fn().mockResolvedValue([]) };
    const txInsert = vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue(txInsertResult),
    });
    const transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        execute: vi.fn().mockResolvedValue([{ tenant: '55' }]),
        insert: txInsert,
        update: vi.fn(),
        delete: vi.fn(),
      }),
    );
    const db = {
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
      transaction,
    };
    const app = createApp({
      // biome-ignore lint/suspicious/noExplicitAny: mock
      db: db as any,
      queue: { enqueue: vi.fn(), dequeue: vi.fn() },
      webhookSecret: SECRET,
      now: () => new Date('2026-06-04T00:00:00Z'),
      allowedSnsTopicArns: [TOPIC],
    });
    const body = JSON.stringify({
      action: 'created',
      installation: {
        id: 55,
        app_id: 42,
        account: { login: 'acme-org', type: 'Organization' },
      },
    });
    const res = await app.request('/webhook', {
      method: 'POST',
      headers: {
        'x-hub-signature-256': sign(body),
        'x-github-event': 'installation',
        'x-github-delivery': 'dlv-install-1',
        'content-type': 'application/json',
      },
      body,
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { kind: string };
    expect(json.kind).toBe('installation');
    // Verify the db.transaction wire is exercised — removing `db: deps.db`
    // from app.ts would make transaction never be called.
    expect(transaction).toHaveBeenCalledOnce();
    expect(txInsert).toHaveBeenCalledOnce();
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

// ---------------------------------------------------------------------------
// #149 inline conversation: handleConversation + getBotLogin wiring
// ---------------------------------------------------------------------------

describe('createApp — #149 conversation wiring', () => {
  it('forwards deps.handleConversation to the webhook handler for pull_request_review_comment replies with @review-agent', async () => {
    // Build a pull_request_review_comment body that is a thread reply mentioning @review-agent.
    const handleConversation = vi.fn().mockResolvedValue('dispatched' as const);
    const checkAuthz = vi.fn().mockResolvedValue({ allowed: true });
    const getBotLogin = vi.fn().mockResolvedValue('review-agent[bot]');
    const app = createApp({
      // biome-ignore lint/suspicious/noExplicitAny: mock
      db: makeDb() as any,
      queue: { enqueue: vi.fn(), dequeue: vi.fn() },
      webhookSecret: SECRET,
      allowedSnsTopicArns: [TOPIC],
      checkGithubFeedbackAuthz: checkAuthz,
      handleConversation,
      getBotLogin,
    });

    const body = JSON.stringify({
      action: 'created',
      installation: { id: 11 },
      repository: { owner: { login: 'o' }, name: 'r' },
      pull_request: { number: 7 },
      comment: {
        id: 200,
        in_reply_to_id: 100,
        body: 'Hey @review-agent, can you clarify?',
        diff_hunk: '@@ -1,2 +1,3 @@',
      },
      sender: { login: 'alice' },
    });
    const res = await app.request('/webhook', {
      method: 'POST',
      headers: {
        'x-hub-signature-256': sign(body),
        'x-github-event': 'pull_request_review_comment',
        'x-github-delivery': 'dlv-conv-1',
        'content-type': 'application/json',
      },
      body,
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { kind: string; outcome: string };
    expect(json.kind).toBe('conversation_reply');
    expect(json.outcome).toBe('dispatched');
    expect(handleConversation).toHaveBeenCalledOnce();
  });

  it('drops conversation self-replies when deps.getBotLogin returns the sender login', async () => {
    // Sender is the bot itself — the self-reply guard must fire.
    const handleConversation = vi.fn().mockResolvedValue('dispatched' as const);
    const getBotLogin = vi.fn().mockResolvedValue('review-agent[bot]');
    const app = createApp({
      // biome-ignore lint/suspicious/noExplicitAny: mock
      db: makeDb() as any,
      queue: { enqueue: vi.fn(), dequeue: vi.fn() },
      webhookSecret: SECRET,
      allowedSnsTopicArns: [TOPIC],
      handleConversation,
      getBotLogin,
    });

    const body = JSON.stringify({
      action: 'created',
      installation: { id: 11 },
      repository: { owner: { login: 'o' }, name: 'r' },
      pull_request: { number: 7 },
      comment: {
        id: 201,
        in_reply_to_id: 100,
        body: '@review-agent following up',
      },
      sender: { login: 'review-agent[bot]' },
    });
    const res = await app.request('/webhook', {
      method: 'POST',
      headers: {
        'x-hub-signature-256': sign(body),
        'x-github-event': 'pull_request_review_comment',
        'x-github-delivery': 'dlv-self-1',
        'content-type': 'application/json',
      },
      body,
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { kind: string; outcome: string };
    expect(json.kind).toBe('conversation_reply');
    expect(json.outcome).toBe('self_reply');
    expect(handleConversation).not.toHaveBeenCalled();
    expect(getBotLogin).toHaveBeenCalledOnce();
  });

  it('uses GITHUB_BOT_LOGIN env var as getBotLogin when no explicit override is supplied', async () => {
    const prev = process.env.GITHUB_BOT_LOGIN;
    process.env.GITHUB_BOT_LOGIN = 'env-bot[bot]';
    try {
      const handleConversation = vi.fn().mockResolvedValue('dispatched' as const);
      const checkAuthz = vi.fn().mockResolvedValue({ allowed: true });
      const app = createApp({
        // biome-ignore lint/suspicious/noExplicitAny: mock
        db: makeDb() as any,
        queue: { enqueue: vi.fn(), dequeue: vi.fn() },
        webhookSecret: SECRET,
        allowedSnsTopicArns: [TOPIC],
        checkGithubFeedbackAuthz: checkAuthz,
        handleConversation,
        // No explicit getBotLogin — should fall back to env.
      });

      // The sender is the env-configured bot — self-reply guard should fire.
      const body = JSON.stringify({
        action: 'created',
        installation: { id: 11 },
        repository: { owner: { login: 'o' }, name: 'r' },
        pull_request: { number: 7 },
        comment: {
          id: 202,
          in_reply_to_id: 100,
          body: '@review-agent hello',
        },
        sender: { login: 'env-bot[bot]' },
      });
      const res = await app.request('/webhook', {
        method: 'POST',
        headers: {
          'x-hub-signature-256': sign(body),
          'x-github-event': 'pull_request_review_comment',
          'x-github-delivery': 'dlv-env-bot-1',
          'content-type': 'application/json',
        },
        body,
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as { kind: string; outcome: string };
      expect(json.kind).toBe('conversation_reply');
      // The sender matches the env-configured bot login → self_reply.
      expect(json.outcome).toBe('self_reply');
      expect(handleConversation).not.toHaveBeenCalled();
    } finally {
      if (prev === undefined) delete process.env.GITHUB_BOT_LOGIN;
      else process.env.GITHUB_BOT_LOGIN = prev;
    }
  });

  it('falls through to legacy command parser when handleConversation is not wired', async () => {
    // Without handleConversation, a pull_request_review_comment reply with @review-agent
    // should fall through to the legacy parser (no conversation_reply result).
    const app = createApp({
      // biome-ignore lint/suspicious/noExplicitAny: mock
      db: makeDb() as any,
      queue: { enqueue: vi.fn(), dequeue: vi.fn() },
      webhookSecret: SECRET,
      allowedSnsTopicArns: [TOPIC],
    });

    const body = JSON.stringify({
      action: 'created',
      installation: { id: 11 },
      repository: { owner: { login: 'o' }, name: 'r' },
      pull_request: { number: 7 },
      comment: {
        id: 203,
        in_reply_to_id: 100,
        body: '@review-agent review',
      },
      sender: { login: 'alice' },
    });
    const res = await app.request('/webhook', {
      method: 'POST',
      headers: {
        'x-hub-signature-256': sign(body),
        'x-github-event': 'pull_request_review_comment',
        'x-github-delivery': 'dlv-fallthrough-1',
        'content-type': 'application/json',
      },
      body,
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { kind: string };
    // Falls through to command parser — 'ignored' (no authz wired) or noop.
    expect(json.kind).not.toBe('conversation_reply');
  });
});
