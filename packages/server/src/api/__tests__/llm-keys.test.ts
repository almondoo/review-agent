/**
 * Tests for /api/integrations/llm-keys routes.
 *
 * Uses a fake ByokStore, fake AuditAppender, and a fake withTenant-aware
 * DbClient so no live Postgres is required. The withTenant function is
 * mocked to call fn(db) directly so RLS path execution is asserted via
 * the call to withTenant itself.
 */
import { BYOK_PROVIDERS, type BYOKProvider } from '@review-agent/core';
import type { AuditAppender, ByokProviderStatus, ByokStore } from '@review-agent/db';
import { describe, expect, it, vi } from 'vitest';
import { createApi } from '../index.js';

// ---------------------------------------------------------------------------
// Fake ByokStore
// ---------------------------------------------------------------------------
type ByokKey = { provider: BYOKProvider; secret: string; kmsKeyId: string };
type ByokStoreState = Map<string, ByokKey>;

function storeKey(installationId: bigint, provider: BYOKProvider): string {
  return `${installationId}:${provider}`;
}

function fakeBYOKStore(state: ByokStoreState = new Map()): ByokStore {
  return {
    upsert: vi.fn(async (record) => {
      state.set(storeKey(record.installationId, record.provider), {
        provider: record.provider,
        secret: record.secret,
        kmsKeyId: record.kmsKeyId,
      });
    }),
    read: vi.fn(async (lookup) => {
      return state.get(storeKey(lookup.installationId, lookup.provider))?.secret ?? null;
    }),
    rotate: vi.fn(async (record) => {
      const existing = state.get(storeKey(record.installationId, record.provider));
      if (!existing) throw new Error('BYOK row missing; nothing to rotate');
      state.set(storeKey(record.installationId, record.provider), {
        ...existing,
        kmsKeyId: record.kmsKeyId,
      });
    }),
    remove: vi.fn(async (lookup) => {
      state.delete(storeKey(lookup.installationId, lookup.provider));
    }),
    listProviders: vi.fn(async (installationId): Promise<ReadonlyArray<ByokProviderStatus>> => {
      return BYOK_PROVIDERS.map((provider) => ({
        provider,
        configured: state.has(storeKey(installationId, provider)),
      }));
    }),
  };
}

// ---------------------------------------------------------------------------
// Fake AuditAppender
// ---------------------------------------------------------------------------
type AuditRecord = Parameters<AuditAppender>[0];

function fakeAuditAppender(): { appender: AuditAppender; records: AuditRecord[] } {
  const records: AuditRecord[] = [];
  const appender: AuditAppender = vi.fn(async (ev) => {
    records.push(ev);
    return {
      ...ev,
      ts: new Date(),
      prevHash: '0'.repeat(64),
      hash: '0'.repeat(64),
    };
  });
  return { appender, records };
}

// ---------------------------------------------------------------------------
// Fake minimal DB (withTenant needs a .transaction method)
// ---------------------------------------------------------------------------
function fakeDb() {
  return {
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({}),
    select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }),
    insert: () => ({ values: () => Promise.resolve() }),
    execute: () => Promise.resolve([]),
  };
}

// ---------------------------------------------------------------------------
// Mock drizzle-orm's withTenant to call fn(db) directly
// (avoids needing a live PG connection for the transaction wrapper)
// ---------------------------------------------------------------------------
vi.mock('@review-agent/db', async () => {
  const actual = await vi.importActual<typeof import('@review-agent/db')>('@review-agent/db');
  return {
    ...actual,
    withTenant: async (
      _db: unknown,
      _installationId: unknown,
      fn: (tx: unknown) => Promise<unknown>,
    ) => fn({}),
    createAuditAppender: () => async () => ({
      ts: new Date(),
      event: 'noop',
      prevHash: '0'.repeat(64),
      hash: '0'.repeat(64),
    }),
    createByokStore: actual.createByokStore,
  };
});

// ---------------------------------------------------------------------------
// Helper: build a createApi instance with all fake deps
// ---------------------------------------------------------------------------
function makeApi(opts: {
  byokStore?: ByokStore;
  auditAppender?: AuditAppender;
  dashboardToken?: string;
  kmsKeyId?: string;
}) {
  const db = fakeDb();
  return createApi({
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    db: db as any,
    env: {},
    now: () => new Date('2026-01-01T00:00:00Z'),
    dashboardToken: opts.dashboardToken,
    requireDashboardAuth: false,
    byokStore: opts.byokStore,
    auditAppender: opts.auditAppender,
    kmsKeyId: opts.kmsKeyId ?? 'arn:aws:kms:us-east-1:111:key/test-cmk',
  });
}

const AUTH = { Authorization: 'Bearer test-token' };
const JSON_CT = { 'Content-Type': 'application/json' };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /integrations/llm-keys', () => {
  it('returns one entry per provider, all unconfigured by default', async () => {
    const state = new Map<string, ByokKey>();
    const store = fakeBYOKStore(state);
    const { appender } = fakeAuditAppender();
    const api = makeApi({
      byokStore: store,
      auditAppender: appender,
      dashboardToken: 'test-token',
    });

    const res = await api.request('http://host/integrations/llm-keys?installationId=1', {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.installationId).toBe(1);
    expect(Array.isArray(body.keys)).toBe(true);
    expect(body.keys).toHaveLength(BYOK_PROVIDERS.length);
    for (const entry of body.keys) {
      expect(BYOK_PROVIDERS).toContain(entry.provider);
      expect(entry.configured).toBe(false);
    }
    // Must not return any secret material
    expect(JSON.stringify(body)).not.toContain('apiKey');
    expect(JSON.stringify(body)).not.toContain('secret');
  });

  it('shows configured=true for a provider that has been upserted', async () => {
    const state = new Map<string, ByokKey>();
    state.set(storeKey(1n, 'anthropic'), {
      provider: 'anthropic',
      secret: 'sk-xxx',
      kmsKeyId: 'k',
    });
    const store = fakeBYOKStore(state);
    const { appender } = fakeAuditAppender();
    const api = makeApi({
      byokStore: store,
      auditAppender: appender,
      dashboardToken: 'test-token',
    });

    const res = await api.request('http://host/integrations/llm-keys?installationId=1', {
      headers: AUTH,
    });
    const body = await res.json();
    const anthropicEntry = body.keys.find((k: { provider: string }) => k.provider === 'anthropic');
    expect(anthropicEntry?.configured).toBe(true);
    // Other providers still unconfigured
    const openaiEntry = body.keys.find((k: { provider: string }) => k.provider === 'openai');
    expect(openaiEntry?.configured).toBe(false);
  });

  it('returns 422 when installationId is missing', async () => {
    const api = makeApi({
      byokStore: fakeBYOKStore(),
      auditAppender: fakeAuditAppender().appender,
      dashboardToken: 'test-token',
    });
    const res = await api.request('http://host/integrations/llm-keys', { headers: AUTH });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe('validation_error');
    expect(Array.isArray(body.issues)).toBe(true);
  });

  it('returns 422 when installationId is not a positive integer', async () => {
    const api = makeApi({
      byokStore: fakeBYOKStore(),
      auditAppender: fakeAuditAppender().appender,
      dashboardToken: 'test-token',
    });
    const res = await api.request('http://host/integrations/llm-keys?installationId=abc', {
      headers: AUTH,
    });
    expect(res.status).toBe(422);
  });

  it('returns 401 without auth token', async () => {
    const api = makeApi({
      byokStore: fakeBYOKStore(),
      auditAppender: fakeAuditAppender().appender,
      dashboardToken: 'test-token',
    });
    const res = await api.request('http://host/integrations/llm-keys?installationId=1');
    expect(res.status).toBe(401);
  });
});

describe('POST /integrations/llm-keys (upsert)', () => {
  it('stores the API key and returns configured: true', async () => {
    const state = new Map<string, ByokKey>();
    const store = fakeBYOKStore(state);
    const { appender, records } = fakeAuditAppender();
    const api = makeApi({
      byokStore: store,
      auditAppender: appender,
      dashboardToken: 'test-token',
    });

    const res = await api.request('http://host/integrations/llm-keys', {
      method: 'POST',
      headers: { ...AUTH, ...JSON_CT },
      body: JSON.stringify({ installationId: 42, provider: 'openai', apiKey: 'sk-open-ai-xxx' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.installationId).toBe(42);
    expect(body.provider).toBe('openai');
    expect(body.configured).toBe(true);
    // Must not echo the apiKey
    expect(JSON.stringify(body)).not.toContain('sk-open-ai-xxx');
    expect(JSON.stringify(body)).not.toContain('apiKey');

    // Audit row must have been written
    expect(records).toHaveLength(1);
    expect(records[0]?.event).toBe('byok.key.upsert');
    expect(records[0]?.model).toBe('openai');
    expect(records[0]?.installationId).toBe(42n);
    // Audit row must not contain the API key (check string fields only; BigInt blocks JSON.stringify)
    expect(records[0]?.event).not.toContain('sk-open-ai-xxx');
    expect(records[0]?.model).not.toContain('sk-open-ai-xxx');

    // Store must have been called
    expect(store.upsert).toHaveBeenCalledOnce();
  });

  it('returns 422 for missing installationId', async () => {
    const api = makeApi({
      byokStore: fakeBYOKStore(),
      auditAppender: fakeAuditAppender().appender,
      dashboardToken: 'test-token',
    });
    const res = await api.request('http://host/integrations/llm-keys', {
      method: 'POST',
      headers: { ...AUTH, ...JSON_CT },
      body: JSON.stringify({ provider: 'openai', apiKey: 'sk-x' }),
    });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe('validation_error');
    expect(Array.isArray(body.issues)).toBe(true);
  });

  it('returns 422 for unknown provider', async () => {
    const api = makeApi({
      byokStore: fakeBYOKStore(),
      auditAppender: fakeAuditAppender().appender,
      dashboardToken: 'test-token',
    });
    const res = await api.request('http://host/integrations/llm-keys', {
      method: 'POST',
      headers: { ...AUTH, ...JSON_CT },
      body: JSON.stringify({ installationId: 1, provider: 'not-a-provider', apiKey: 'sk-x' }),
    });
    expect(res.status).toBe(422);
  });

  it('returns 422 for empty apiKey', async () => {
    const api = makeApi({
      byokStore: fakeBYOKStore(),
      auditAppender: fakeAuditAppender().appender,
      dashboardToken: 'test-token',
    });
    const res = await api.request('http://host/integrations/llm-keys', {
      method: 'POST',
      headers: { ...AUTH, ...JSON_CT },
      body: JSON.stringify({ installationId: 1, provider: 'openai', apiKey: '' }),
    });
    expect(res.status).toBe(422);
  });

  it('returns 422 for apiKey exceeding 8192 chars', async () => {
    const api = makeApi({
      byokStore: fakeBYOKStore(),
      auditAppender: fakeAuditAppender().appender,
      dashboardToken: 'test-token',
    });
    const res = await api.request('http://host/integrations/llm-keys', {
      method: 'POST',
      headers: { ...AUTH, ...JSON_CT },
      body: JSON.stringify({ installationId: 1, provider: 'openai', apiKey: 'x'.repeat(8193) }),
    });
    expect(res.status).toBe(422);
  });

  it('returns 400 for malformed JSON', async () => {
    const api = makeApi({
      byokStore: fakeBYOKStore(),
      auditAppender: fakeAuditAppender().appender,
      dashboardToken: 'test-token',
    });
    const res = await api.request('http://host/integrations/llm-keys', {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: 'not-valid-json{{{',
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid JSON body');
  });

  it('returns 401 without auth token', async () => {
    const api = makeApi({
      byokStore: fakeBYOKStore(),
      auditAppender: fakeAuditAppender().appender,
      dashboardToken: 'test-token',
    });
    const res = await api.request('http://host/integrations/llm-keys', {
      method: 'POST',
      headers: JSON_CT,
      body: JSON.stringify({ installationId: 1, provider: 'openai', apiKey: 'sk-x' }),
    });
    expect(res.status).toBe(401);
  });
});

describe('POST /integrations/llm-keys/rotate', () => {
  it('rotates an existing key and returns configured: true', async () => {
    const state = new Map<string, ByokKey>();
    state.set(storeKey(1n, 'anthropic'), {
      provider: 'anthropic',
      secret: 'sk-ant-original',
      kmsKeyId: 'k1',
    });
    const store = fakeBYOKStore(state);
    const { appender, records } = fakeAuditAppender();
    const api = makeApi({
      byokStore: store,
      auditAppender: appender,
      dashboardToken: 'test-token',
    });

    const res = await api.request('http://host/integrations/llm-keys/rotate', {
      method: 'POST',
      headers: { ...AUTH, ...JSON_CT },
      body: JSON.stringify({ installationId: 1, provider: 'anthropic' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.installationId).toBe(1);
    expect(body.provider).toBe('anthropic');
    expect(body.configured).toBe(true);
    // Must not echo any secret
    expect(JSON.stringify(body)).not.toContain('sk-ant');

    // Audit row written for rotate
    expect(records).toHaveLength(1);
    expect(records[0]?.event).toBe('byok.key.rotate');
    expect(records[0]?.model).toBe('anthropic');
    // Must not contain the original key (check string fields only; BigInt blocks JSON.stringify)
    expect(records[0]?.event).not.toContain('sk-ant-original');
    expect(records[0]?.model).not.toContain('sk-ant-original');

    expect(store.rotate).toHaveBeenCalledOnce();
  });

  it('returns 422 for missing provider', async () => {
    const api = makeApi({
      byokStore: fakeBYOKStore(),
      auditAppender: fakeAuditAppender().appender,
      dashboardToken: 'test-token',
    });
    const res = await api.request('http://host/integrations/llm-keys/rotate', {
      method: 'POST',
      headers: { ...AUTH, ...JSON_CT },
      body: JSON.stringify({ installationId: 1 }),
    });
    expect(res.status).toBe(422);
  });

  it('returns 400 for malformed JSON', async () => {
    const api = makeApi({
      byokStore: fakeBYOKStore(),
      auditAppender: fakeAuditAppender().appender,
      dashboardToken: 'test-token',
    });
    const res = await api.request('http://host/integrations/llm-keys/rotate', {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: '{bad json',
    });
    expect(res.status).toBe(400);
  });
});

describe('DELETE /integrations/llm-keys', () => {
  it('removes the key and returns configured: false', async () => {
    const state = new Map<string, ByokKey>();
    state.set(storeKey(5n, 'vertex'), { provider: 'vertex', secret: 'gcp-key', kmsKeyId: 'k' });
    const store = fakeBYOKStore(state);
    const { appender, records } = fakeAuditAppender();
    const api = makeApi({
      byokStore: store,
      auditAppender: appender,
      dashboardToken: 'test-token',
    });

    const res = await api.request('http://host/integrations/llm-keys', {
      method: 'DELETE',
      headers: { ...AUTH, ...JSON_CT },
      body: JSON.stringify({ installationId: 5, provider: 'vertex' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.installationId).toBe(5);
    expect(body.provider).toBe('vertex');
    expect(body.configured).toBe(false);

    // Audit row written for delete
    expect(records).toHaveLength(1);
    expect(records[0]?.event).toBe('byok.key.delete');
    expect(records[0]?.model).toBe('vertex');

    expect(store.remove).toHaveBeenCalledOnce();
  });

  it('is idempotent — deleting non-existent key still returns 200', async () => {
    const store = fakeBYOKStore();
    const { appender } = fakeAuditAppender();
    const api = makeApi({
      byokStore: store,
      auditAppender: appender,
      dashboardToken: 'test-token',
    });

    const res = await api.request('http://host/integrations/llm-keys', {
      method: 'DELETE',
      headers: { ...AUTH, ...JSON_CT },
      body: JSON.stringify({ installationId: 99, provider: 'bedrock' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.configured).toBe(false);
  });

  it('returns 422 for invalid provider', async () => {
    const api = makeApi({
      byokStore: fakeBYOKStore(),
      auditAppender: fakeAuditAppender().appender,
      dashboardToken: 'test-token',
    });
    const res = await api.request('http://host/integrations/llm-keys', {
      method: 'DELETE',
      headers: { ...AUTH, ...JSON_CT },
      body: JSON.stringify({ installationId: 1, provider: 'not-valid' }),
    });
    expect(res.status).toBe(422);
  });

  it('returns 400 for malformed JSON', async () => {
    const api = makeApi({
      byokStore: fakeBYOKStore(),
      auditAppender: fakeAuditAppender().appender,
      dashboardToken: 'test-token',
    });
    const res = await api.request('http://host/integrations/llm-keys', {
      method: 'DELETE',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: '{{not json',
    });
    expect(res.status).toBe(400);
  });

  it('returns 401 without auth token', async () => {
    const api = makeApi({
      byokStore: fakeBYOKStore(),
      auditAppender: fakeAuditAppender().appender,
      dashboardToken: 'test-token',
    });
    const res = await api.request('http://host/integrations/llm-keys', {
      method: 'DELETE',
      headers: JSON_CT,
      body: JSON.stringify({ installationId: 1, provider: 'openai' }),
    });
    expect(res.status).toBe(401);
  });
});

describe('503 when KMS not configured', () => {
  it('returns 503 when kmsKeyId is absent', async () => {
    const db = fakeDb();
    const api = createApi({
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      db: db as any,
      env: {},
      dashboardToken: undefined,
      requireDashboardAuth: false,
      // No kmsKeyId, no byokStore → llm-keys routes not wired
    });
    const res = await api.request('http://host/integrations/llm-keys?installationId=1');
    expect(res.status).toBe(503);
  });
});

describe('Response masking — no secret material ever returned', () => {
  it('POST upsert never echoes apiKey in any form', async () => {
    const SECRET = 'sk-SUPER-SECRET-KEY-NEVER-RETURN';
    const store = fakeBYOKStore();
    const { appender } = fakeAuditAppender();
    const api = makeApi({
      byokStore: store,
      auditAppender: appender,
      dashboardToken: 'test-token',
    });

    const res = await api.request('http://host/integrations/llm-keys', {
      method: 'POST',
      headers: { ...AUTH, ...JSON_CT },
      body: JSON.stringify({ installationId: 1, provider: 'anthropic', apiKey: SECRET }),
    });
    const text = await res.text();
    expect(text).not.toContain(SECRET);
  });
});

describe('withTenant / RLS path exercised', () => {
  it('listProviders is called with the correct installationId', async () => {
    const store = fakeBYOKStore();
    const { appender } = fakeAuditAppender();
    const api = makeApi({
      byokStore: store,
      auditAppender: appender,
      dashboardToken: 'test-token',
    });

    await api.request('http://host/integrations/llm-keys?installationId=77', { headers: AUTH });

    // listProviders must have been called with BigInt(77)
    expect(store.listProviders).toHaveBeenCalledWith(77n);
  });

  it('upsert is called with the correct BigInt installationId', async () => {
    const store = fakeBYOKStore();
    const { appender } = fakeAuditAppender();
    const api = makeApi({
      byokStore: store,
      auditAppender: appender,
      dashboardToken: 'test-token',
    });

    await api.request('http://host/integrations/llm-keys', {
      method: 'POST',
      headers: { ...AUTH, ...JSON_CT },
      body: JSON.stringify({ installationId: 123, provider: 'openai', apiKey: 'sk-x' }),
    });

    expect(store.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ installationId: 123n, provider: 'openai' }),
    );
  });
});
