/**
 * Tests for /api/integrations/llm-keys routes.
 *
 * Uses a fake KmsClient, fake AuditAppender, and a fake DbClient so no live
 * Postgres is required.
 *
 * The key RLS invariant is that every byok-store call must happen on the
 * `tx` connection that withTenant set the GUC on — NOT on the pool `db`.
 * The regression test section at the bottom proves this with a spy that
 * captures which `db` instance was passed to `createByokStore`.
 *
 * Multi-tenant guard tests (issue #132):
 *   - multiTenant=false (default): routes behave as today (no regression).
 *   - multiTenant=true: routes return 501 before any withTenant/DB write.
 */
import { BYOK_PROVIDERS, type BYOKProvider, type KmsClient } from '@review-agent/core';
import type { AuditAppender, ByokProviderStatus, ByokStore } from '@review-agent/db';
import { describe, expect, it, vi } from 'vitest';
import { createApi } from '../index.js';

// ---------------------------------------------------------------------------
// Fake KmsClient (no real AWS calls)
// ---------------------------------------------------------------------------
function fakeKmsClient(): KmsClient {
  return {
    encryptDataKey: vi.fn(async (plaintext) => Buffer.from(plaintext)),
    decryptDataKey: vi.fn(async (ciphertext) => Buffer.from(ciphertext)),
  };
}

// ---------------------------------------------------------------------------
// Fake ByokStore (returned by the mocked createByokStore)
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
// Module mock: replace withTenant and createByokStore with controllable fakes.
//
// createByokStore is mocked so we can:
//   1. Control what store instance is returned (per-test state).
//   2. Spy on which `db` argument it receives — the regression test uses this
//      to assert the tx (not the pool db) is threaded in.
//
// withTenant is mocked to call fn(SENTINEL_TX) where SENTINEL_TX is a
// distinct object from the pool `db`. The regression test verifies
// createByokStore was called with SENTINEL_TX, not with pool db.
// ---------------------------------------------------------------------------

/** Sentinel transaction object — distinct from any fakeDb() instance. */
const SENTINEL_TX = { _isTx: true as const };

// Per-test store factory. Tests that need a custom store set this before calling makeApi.
let currentStoreFactory: (() => ByokStore) | null = null;

vi.mock('@review-agent/db', async () => {
  const actual = await vi.importActual<typeof import('@review-agent/db')>('@review-agent/db');
  return {
    ...actual,
    withTenant: async (
      _db: unknown,
      _installationId: unknown,
      fn: (tx: unknown) => Promise<unknown>,
    ) => fn(SENTINEL_TX),
    createAuditAppender: () => async () => ({
      ts: new Date(),
      event: 'noop',
      prevHash: '0'.repeat(64),
      hash: '0'.repeat(64),
    }),
    createByokStore: vi.fn((_deps: unknown) => {
      if (currentStoreFactory) return currentStoreFactory();
      return fakeBYOKStore();
    }),
  };
});

// ---------------------------------------------------------------------------
// Helper: build a createApi instance with all fake deps
// ---------------------------------------------------------------------------
function makeApi(opts: {
  kmsClient?: KmsClient;
  auditAppender?: AuditAppender;
  dashboardToken?: string;
  kmsKeyId?: string;
  multiTenant?: boolean;
}) {
  const db = fakeDb();
  return {
    api: createApi({
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      db: db as any,
      env: {},
      now: () => new Date('2026-01-01T00:00:00Z'),
      dashboardToken: opts.dashboardToken,
      requireDashboardAuth: false,
      kmsClient: opts.kmsClient ?? fakeKmsClient(),
      auditAppender: opts.auditAppender,
      kmsKeyId: opts.kmsKeyId ?? 'arn:aws:kms:us-east-1:111:key/test-cmk',
      ...(opts.multiTenant !== undefined ? { multiTenant: opts.multiTenant } : {}),
    }),
    db,
  };
}

const AUTH = { Authorization: 'Bearer test-token' };
const JSON_CT = { 'Content-Type': 'application/json' };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /integrations/llm-keys', () => {
  it('returns one entry per provider, all unconfigured by default', async () => {
    const state = new Map<string, ByokKey>();
    currentStoreFactory = () => fakeBYOKStore(state);
    const { appender } = fakeAuditAppender();
    const { api } = makeApi({
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
    currentStoreFactory = () => fakeBYOKStore(state);
    const { appender } = fakeAuditAppender();
    const { api } = makeApi({
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
    currentStoreFactory = () => fakeBYOKStore();
    const { api } = makeApi({
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
    currentStoreFactory = () => fakeBYOKStore();
    const { api } = makeApi({
      auditAppender: fakeAuditAppender().appender,
      dashboardToken: 'test-token',
    });
    const res = await api.request('http://host/integrations/llm-keys?installationId=abc', {
      headers: AUTH,
    });
    expect(res.status).toBe(422);
  });

  it('returns 401 without auth token', async () => {
    currentStoreFactory = () => fakeBYOKStore();
    const { api } = makeApi({
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
    currentStoreFactory = () => store;
    const { appender, records } = fakeAuditAppender();
    const { api } = makeApi({
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
    currentStoreFactory = () => fakeBYOKStore();
    const { api } = makeApi({
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
    currentStoreFactory = () => fakeBYOKStore();
    const { api } = makeApi({
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
    currentStoreFactory = () => fakeBYOKStore();
    const { api } = makeApi({
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
    currentStoreFactory = () => fakeBYOKStore();
    const { api } = makeApi({
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
    currentStoreFactory = () => fakeBYOKStore();
    const { api } = makeApi({
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
    currentStoreFactory = () => fakeBYOKStore();
    const { api } = makeApi({
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
    currentStoreFactory = () => store;
    const { appender, records } = fakeAuditAppender();
    const { api } = makeApi({
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

  it('returns 404 when rotating a non-existent key', async () => {
    // Rotating a key that does not exist must return 404, not 500.
    // The byok-store throws Error('BYOK row missing ...') — the handler must
    // catch it and map to { error: 'key_not_found' } 404.
    currentStoreFactory = () => fakeBYOKStore(); // empty state
    const { appender } = fakeAuditAppender();
    const { api } = makeApi({
      auditAppender: appender,
      dashboardToken: 'test-token',
    });

    const res = await api.request('http://host/integrations/llm-keys/rotate', {
      method: 'POST',
      headers: { ...AUTH, ...JSON_CT },
      body: JSON.stringify({ installationId: 99, provider: 'anthropic' }),
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('key_not_found');
    // Must not leak installationId or provider in the error body
    expect(JSON.stringify(body)).not.toContain('99');
    expect(JSON.stringify(body)).not.toContain('anthropic');
  });

  it('returns 422 for missing provider', async () => {
    currentStoreFactory = () => fakeBYOKStore();
    const { api } = makeApi({
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
    currentStoreFactory = () => fakeBYOKStore();
    const { api } = makeApi({
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
    currentStoreFactory = () => store;
    const { appender, records } = fakeAuditAppender();
    const { api } = makeApi({
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
    currentStoreFactory = () => fakeBYOKStore();
    const { appender } = fakeAuditAppender();
    const { api } = makeApi({
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
    currentStoreFactory = () => fakeBYOKStore();
    const { api } = makeApi({
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
    currentStoreFactory = () => fakeBYOKStore();
    const { api } = makeApi({
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
    currentStoreFactory = () => fakeBYOKStore();
    const { api } = makeApi({
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
      // No kmsKeyId, no kmsClient → llm-keys routes not wired
    });
    const res = await api.request('http://host/integrations/llm-keys?installationId=1');
    expect(res.status).toBe(503);
  });
});

describe('Response masking — no secret material ever returned', () => {
  it('POST upsert never echoes apiKey in any form', async () => {
    const SECRET = 'sk-SUPER-SECRET-KEY-NEVER-RETURN';
    currentStoreFactory = () => fakeBYOKStore();
    const { appender } = fakeAuditAppender();
    const { api } = makeApi({
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
    currentStoreFactory = () => store;
    const { appender } = fakeAuditAppender();
    const { api } = makeApi({
      auditAppender: appender,
      dashboardToken: 'test-token',
    });

    await api.request('http://host/integrations/llm-keys?installationId=77', { headers: AUTH });

    // listProviders must have been called with BigInt(77)
    expect(store.listProviders).toHaveBeenCalledWith(77n);
  });

  it('upsert is called with the correct BigInt installationId', async () => {
    const store = fakeBYOKStore();
    currentStoreFactory = () => store;
    const { appender } = fakeAuditAppender();
    const { api } = makeApi({
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

// ---------------------------------------------------------------------------
// P0 Regression: createByokStore must be called with the tx from withTenant,
// NOT with the pool db. This test would FAIL against the old pool-bound code
// (where deps.byokStore was constructed once with pool db and reused).
// ---------------------------------------------------------------------------
describe('P0 regression — byok store constructed with tx, not pool db', () => {
  it('createByokStore receives the tx from withTenant for GET listProviders', async () => {
    const { createByokStore: mockCreateByokStore } = await import('@review-agent/db');
    const createByokStoreSpy = vi.mocked(mockCreateByokStore);
    createByokStoreSpy.mockClear();

    const store = fakeBYOKStore();
    currentStoreFactory = () => store;
    const { appender } = fakeAuditAppender();
    const { api, db } = makeApi({
      auditAppender: appender,
      dashboardToken: 'test-token',
    });

    await api.request('http://host/integrations/llm-keys?installationId=5', { headers: AUTH });

    // createByokStore must have been called exactly once with the tx (SENTINEL_TX),
    // not with the pool db.
    expect(createByokStoreSpy).toHaveBeenCalledOnce();
    const callArg = createByokStoreSpy.mock.calls[0]?.[0];
    expect(callArg?.db).toBe(SENTINEL_TX);
    // Must NOT have been called with the pool db
    expect(callArg?.db).not.toBe(db);
  });

  it('createByokStore receives the tx from withTenant for POST upsert', async () => {
    const { createByokStore: mockCreateByokStore } = await import('@review-agent/db');
    const createByokStoreSpy = vi.mocked(mockCreateByokStore);
    createByokStoreSpy.mockClear();

    const store = fakeBYOKStore();
    currentStoreFactory = () => store;
    const { appender } = fakeAuditAppender();
    const { api, db } = makeApi({
      auditAppender: appender,
      dashboardToken: 'test-token',
    });

    await api.request('http://host/integrations/llm-keys', {
      method: 'POST',
      headers: { ...AUTH, ...JSON_CT },
      body: JSON.stringify({ installationId: 10, provider: 'openai', apiKey: 'sk-x' }),
    });

    expect(createByokStoreSpy).toHaveBeenCalledOnce();
    const callArg = createByokStoreSpy.mock.calls[0]?.[0];
    expect(callArg?.db).toBe(SENTINEL_TX);
    expect(callArg?.db).not.toBe(db);
  });

  it('createByokStore receives the tx from withTenant for POST rotate', async () => {
    const { createByokStore: mockCreateByokStore } = await import('@review-agent/db');
    const createByokStoreSpy = vi.mocked(mockCreateByokStore);
    createByokStoreSpy.mockClear();

    const state = new Map<string, ByokKey>();
    state.set(storeKey(3n, 'openai'), { provider: 'openai', secret: 'sk-old', kmsKeyId: 'k' });
    currentStoreFactory = () => fakeBYOKStore(state);
    const { appender } = fakeAuditAppender();
    const { api, db } = makeApi({
      auditAppender: appender,
      dashboardToken: 'test-token',
    });

    await api.request('http://host/integrations/llm-keys/rotate', {
      method: 'POST',
      headers: { ...AUTH, ...JSON_CT },
      body: JSON.stringify({ installationId: 3, provider: 'openai' }),
    });

    expect(createByokStoreSpy).toHaveBeenCalledOnce();
    const callArg = createByokStoreSpy.mock.calls[0]?.[0];
    expect(callArg?.db).toBe(SENTINEL_TX);
    expect(callArg?.db).not.toBe(db);
  });

  it('createByokStore receives the tx from withTenant for DELETE remove', async () => {
    const { createByokStore: mockCreateByokStore } = await import('@review-agent/db');
    const createByokStoreSpy = vi.mocked(mockCreateByokStore);
    createByokStoreSpy.mockClear();

    const state = new Map<string, ByokKey>();
    state.set(storeKey(7n, 'vertex'), { provider: 'vertex', secret: 'gcp-key', kmsKeyId: 'k' });
    currentStoreFactory = () => fakeBYOKStore(state);
    const { appender } = fakeAuditAppender();
    const { api, db } = makeApi({
      auditAppender: appender,
      dashboardToken: 'test-token',
    });

    await api.request('http://host/integrations/llm-keys', {
      method: 'DELETE',
      headers: { ...AUTH, ...JSON_CT },
      body: JSON.stringify({ installationId: 7, provider: 'vertex' }),
    });

    expect(createByokStoreSpy).toHaveBeenCalledOnce();
    const callArg = createByokStoreSpy.mock.calls[0]?.[0];
    expect(callArg?.db).toBe(SENTINEL_TX);
    expect(callArg?.db).not.toBe(db);
  });
});

// ---------------------------------------------------------------------------
// Audit best-effort: when auditAppender throws, the HTTP response is still 200
// and a warning is written to stderr (not a 500).
// ---------------------------------------------------------------------------
describe('audit failure is best-effort — does not fail the HTTP response', () => {
  it('POST upsert returns 200 even when auditAppender throws', async () => {
    const store = fakeBYOKStore();
    currentStoreFactory = () => store;
    const failingAppender: AuditAppender = vi.fn(async () => {
      throw new Error('audit DB down');
    });
    const { api } = makeApi({
      auditAppender: failingAppender,
      dashboardToken: 'test-token',
    });

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const res = await api.request('http://host/integrations/llm-keys', {
        method: 'POST',
        headers: { ...AUTH, ...JSON_CT },
        body: JSON.stringify({ installationId: 1, provider: 'openai', apiKey: 'sk-x' }),
      });
      expect(res.status).toBe(200);
      // A warning must have been emitted to stderr
      const warnCalls = stderrSpy.mock.calls.map((c) => String(c[0]));
      expect(warnCalls.some((s) => s.includes('audit write failed'))).toBe(true);
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it('POST rotate returns 200 even when auditAppender throws', async () => {
    const state = new Map<string, ByokKey>();
    state.set(storeKey(2n, 'anthropic'), {
      provider: 'anthropic',
      secret: 'sk-orig',
      kmsKeyId: 'k',
    });
    currentStoreFactory = () => fakeBYOKStore(state);
    const failingAppender: AuditAppender = vi.fn(async () => {
      throw new Error('audit DB down');
    });
    const { api } = makeApi({
      auditAppender: failingAppender,
      dashboardToken: 'test-token',
    });

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const res = await api.request('http://host/integrations/llm-keys/rotate', {
        method: 'POST',
        headers: { ...AUTH, ...JSON_CT },
        body: JSON.stringify({ installationId: 2, provider: 'anthropic' }),
      });
      expect(res.status).toBe(200);
      const warnCalls = stderrSpy.mock.calls.map((c) => String(c[0]));
      expect(warnCalls.some((s) => s.includes('audit write failed'))).toBe(true);
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it('DELETE returns 200 even when auditAppender throws', async () => {
    const state = new Map<string, ByokKey>();
    state.set(storeKey(4n, 'openai'), { provider: 'openai', secret: 'sk-x', kmsKeyId: 'k' });
    currentStoreFactory = () => fakeBYOKStore(state);
    const failingAppender: AuditAppender = vi.fn(async () => {
      throw new Error('audit DB down');
    });
    const { api } = makeApi({
      auditAppender: failingAppender,
      dashboardToken: 'test-token',
    });

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const res = await api.request('http://host/integrations/llm-keys', {
        method: 'DELETE',
        headers: { ...AUTH, ...JSON_CT },
        body: JSON.stringify({ installationId: 4, provider: 'openai' }),
      });
      expect(res.status).toBe(200);
      const warnCalls = stderrSpy.mock.calls.map((c) => String(c[0]));
      expect(warnCalls.some((s) => s.includes('audit write failed'))).toBe(true);
    } finally {
      stderrSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// P2: kmsClient without kmsKeyId emits a startup WARN and returns 503
// ---------------------------------------------------------------------------
describe('503 with WARN when kmsClient present but kmsKeyId absent', () => {
  it('emits a startup WARN naming kmsKeyId and returns 503', async () => {
    const db = fakeDb();
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    let api: ReturnType<typeof createApi>;
    try {
      api = createApi({
        // biome-ignore lint/suspicious/noExplicitAny: test mock
        db: db as any,
        env: {},
        dashboardToken: 'tok',
        requireDashboardAuth: false,
        kmsClient: fakeKmsClient(),
        // kmsKeyId intentionally omitted
      });
      const warnCalls = stderrSpy.mock.calls.map((c) => String(c[0]));
      expect(warnCalls.some((s) => s.includes('kmsKeyId') && s.includes('BYOK'))).toBe(true);
    } finally {
      stderrSpy.mockRestore();
    }
    const res = await api.request('http://host/integrations/llm-keys?installationId=1', {
      headers: { Authorization: 'Bearer tok' },
    });
    expect(res.status).toBe(503);
  });
});

// ---------------------------------------------------------------------------
// Multi-tenant guard tests (issue #132)
// ---------------------------------------------------------------------------

describe('multi-tenant guard: GET /integrations/llm-keys (list)', () => {
  it('multiTenant=false (default): route proceeds normally (no regression)', async () => {
    const store = fakeBYOKStore();
    currentStoreFactory = () => store;
    const { appender } = fakeAuditAppender();
    const { api } = makeApi({
      auditAppender: appender,
      dashboardToken: 'test-token',
      multiTenant: false,
    });
    const res = await api.request('http://host/integrations/llm-keys?installationId=1', {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    // DB read was exercised (listProviders was called)
    expect(store.listProviders).toHaveBeenCalledOnce();
  });

  it('multiTenant=true: returns 501 with correct error envelope', async () => {
    const store = fakeBYOKStore();
    currentStoreFactory = () => store;
    const { appender } = fakeAuditAppender();
    const { api } = makeApi({
      auditAppender: appender,
      dashboardToken: 'test-token',
      multiTenant: true,
    });
    const res = await api.request('http://host/integrations/llm-keys?installationId=1', {
      headers: AUTH,
    });
    expect(res.status).toBe(501);
    const body = await res.json();
    expect(typeof body.error).toBe('string');
    expect(body.error).toContain('per_installation_authz_not_implemented');
  });

  it('multiTenant=true: withTenant / DB read is NOT performed', async () => {
    const store = fakeBYOKStore();
    currentStoreFactory = () => store;
    const { appender } = fakeAuditAppender();
    const { api } = makeApi({
      auditAppender: appender,
      dashboardToken: 'test-token',
      multiTenant: true,
    });
    await api.request('http://host/integrations/llm-keys?installationId=1', {
      headers: AUTH,
    });
    // listProviders must NOT have been called
    expect(store.listProviders).not.toHaveBeenCalled();
  });
});

describe('multi-tenant guard: POST /integrations/llm-keys (upsert)', () => {
  it('multiTenant=false (default): route proceeds normally (no regression)', async () => {
    const store = fakeBYOKStore();
    currentStoreFactory = () => store;
    const { appender } = fakeAuditAppender();
    const { api } = makeApi({
      auditAppender: appender,
      dashboardToken: 'test-token',
      multiTenant: false,
    });
    const res = await api.request('http://host/integrations/llm-keys', {
      method: 'POST',
      headers: { ...AUTH, ...JSON_CT },
      body: JSON.stringify({ installationId: 1, provider: 'openai', apiKey: 'sk-x' }),
    });
    expect(res.status).toBe(200);
    expect(store.upsert).toHaveBeenCalledOnce();
  });

  it('multiTenant=true: returns 501 before DB write', async () => {
    const store = fakeBYOKStore();
    currentStoreFactory = () => store;
    const { appender } = fakeAuditAppender();
    const { api } = makeApi({
      auditAppender: appender,
      dashboardToken: 'test-token',
      multiTenant: true,
    });
    const res = await api.request('http://host/integrations/llm-keys', {
      method: 'POST',
      headers: { ...AUTH, ...JSON_CT },
      body: JSON.stringify({ installationId: 1, provider: 'openai', apiKey: 'sk-x' }),
    });
    expect(res.status).toBe(501);
    const body = await res.json();
    expect(body.error).toContain('per_installation_authz_not_implemented');
    // DB write must NOT have been performed
    expect(store.upsert).not.toHaveBeenCalled();
  });
});
