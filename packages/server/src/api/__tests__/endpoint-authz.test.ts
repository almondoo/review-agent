/**
 * Endpoint-level authorization tests (section F).
 *
 * Tests the full createApi stack in session mode to verify:
 *   1. Role enforcement on sensitive endpoints (403 for insufficient role, 200 for correct role).
 *   2. Cross-principal isolation (404 when installation belongs to a different principal).
 *   3. Audit actor threading (actor=principal.id in audit records for admin actions).
 *   4. Legacy regression (legacy mode, no principal → existing behaviour unchanged).
 *
 * Uses:
 *   - createApi with authMode='session' for JWT tests.
 *   - createApi with authMode='legacy' for regression tests.
 *   - In-memory DB mocks + fake KmsClient + fake AuditAppender (no real Postgres).
 */
import type { BYOKProvider, KmsClient } from '@review-agent/core';
import { hashPassword } from '@review-agent/core';
import { installationMemberships, operatorPrincipals } from '@review-agent/core/db';
import type { AuditAppender, AuditRow, ByokProviderStatus, ByokStore } from '@review-agent/db';
import { describe, expect, it, vi } from 'vitest';
import { issueSessionToken } from '../../auth/jwt.js';
import { createApi } from '../index.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SESSION_SECRET = 'a-test-secret-that-is-at-least-32-chars!!';
const INSTALLATION_ID = 42;
const OTHER_INSTALLATION_ID_STR = '999';

const ADMIN_PRINCIPAL = { id: 'p-admin', username: 'admin', tokenVersion: 1 };
const VIEWER_PRINCIPAL = { id: 'p-viewer', username: 'viewer', tokenVersion: 1 };
const PASSWORD = 'hunter2';
const ADMIN_HASH = hashPassword(PASSWORD);

// ---------------------------------------------------------------------------
// DB mock (supports principal lookups + membership lookups)
// ---------------------------------------------------------------------------

type PrincipalRow = { id: string; username: string; passwordHash: string; tokenVersion: number };
type MembershipRow = { principalId: string; installationId: bigint; role: string };

// biome-ignore lint/suspicious/noExplicitAny: test mock
function makeDb(principals: PrincipalRow[], memberships: MembershipRow[]): any {
  return {
    select: () => ({
      from: (table: unknown) => ({
        where: () => {
          const rows =
            table === operatorPrincipals
              ? principals
              : table === installationMemberships
                ? memberships
                : [];
          const p: Promise<unknown[]> & { limit: (n: number) => Promise<unknown[]> } =
            Object.assign(Promise.resolve(rows), {
              limit: (n: number) => Promise.resolve(rows.slice(0, n)),
            });
          return p;
        },
        orderBy: () => Promise.resolve([]),
      }),
    }),
    insert: () => ({ values: () => Promise.resolve() }),
    update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({}),
    execute: async () => [],
  };
}

// ---------------------------------------------------------------------------
// Fake KMS + BYOK store (identical to llm-keys.test.ts pattern)
// ---------------------------------------------------------------------------

function fakeKmsClient(): KmsClient {
  return {
    encryptDataKey: vi.fn(async (plaintext) => Buffer.from(plaintext)),
    decryptDataKey: vi.fn(async (ciphertext) => Buffer.from(ciphertext)),
  };
}

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
    read: vi.fn(
      async (lookup) => state.get(storeKey(lookup.installationId, lookup.provider))?.secret ?? null,
    ),
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
    listProviders: vi.fn(
      async (installationId): Promise<ReadonlyArray<ByokProviderStatus>> => [
        { provider: 'openai', configured: state.has(storeKey(installationId, 'openai')) },
      ],
    ),
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
    return { ...ev, ts: new Date(), prevHash: '0'.repeat(64), hash: '0'.repeat(64) } as AuditRow;
  });
  return { appender, records };
}

// ---------------------------------------------------------------------------
// Module mock for @review-agent/db (withTenant + createByokStore)
// ---------------------------------------------------------------------------

const SENTINEL_TX = { _isTx: true as const };
let currentStoreFactory: (() => ByokStore) | null = null;

vi.mock('@review-agent/db', async () => {
  const actual = await vi.importActual<typeof import('@review-agent/db')>('@review-agent/db');
  return {
    ...actual,
    withTenant: async (_db: unknown, _id: unknown, fn: (tx: unknown) => Promise<unknown>) =>
      fn(SENTINEL_TX),
    createAuditAppender: () => async () => ({
      ts: new Date(),
      event: 'noop',
      prevHash: '0'.repeat(64),
      hash: '0'.repeat(64),
    }),
    createByokStore: vi.fn((_deps: unknown) =>
      currentStoreFactory ? currentStoreFactory() : fakeBYOKStore(),
    ),
  };
});

// ---------------------------------------------------------------------------
// createApi factory helpers
// ---------------------------------------------------------------------------

function makeSessionApi(opts: {
  principals?: PrincipalRow[];
  memberships?: MembershipRow[];
  auditAppender?: AuditAppender;
}) {
  const db = makeDb(opts.principals ?? [], opts.memberships ?? []);
  const { appender, records } = opts.auditAppender
    ? { appender: opts.auditAppender, records: [] as AuditRecord[] }
    : fakeAuditAppender();
  return {
    api: createApi({
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      db: db as any,
      env: {},
      authMode: 'session',
      sessionSecret: SESSION_SECRET,
      sessionTtlSeconds: 3600,
      kmsClient: fakeKmsClient(),
      auditAppender: appender,
      kmsKeyId: 'arn:aws:kms:us-east-1:111:key/test-cmk',
    }),
    records,
  };
}

function makeLegacyApi() {
  const db = makeDb(
    [{ id: 'p-legacy', username: 'legacy', passwordHash: ADMIN_HASH, tokenVersion: 1 }],
    [],
  );
  const { appender, records } = fakeAuditAppender();
  return {
    api: createApi({
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      db: db as any,
      env: {},
      authMode: 'legacy',
      dashboardToken: 'legacy-token',
      kmsClient: fakeKmsClient(),
      auditAppender: appender,
      kmsKeyId: 'arn:aws:kms:us-east-1:111:key/test-cmk',
    }),
    records,
  };
}

// ---------------------------------------------------------------------------
// JWT helpers
// ---------------------------------------------------------------------------

async function adminJwt() {
  return issueSessionToken(
    {
      principalId: ADMIN_PRINCIPAL.id,
      username: ADMIN_PRINCIPAL.username,
      tokenVersion: ADMIN_PRINCIPAL.tokenVersion,
    },
    SESSION_SECRET,
    3600,
  );
}

async function viewerJwt() {
  return issueSessionToken(
    {
      principalId: VIEWER_PRINCIPAL.id,
      username: VIEWER_PRINCIPAL.username,
      tokenVersion: VIEWER_PRINCIPAL.tokenVersion,
    },
    SESSION_SECRET,
    3600,
  );
}

// ---------------------------------------------------------------------------
// Standard memberships for tests
// ---------------------------------------------------------------------------

const ADMIN_MEMBERSHIP: MembershipRow = {
  principalId: ADMIN_PRINCIPAL.id,
  installationId: BigInt(INSTALLATION_ID),
  role: 'admin',
};

const VIEWER_MEMBERSHIP: MembershipRow = {
  principalId: VIEWER_PRINCIPAL.id,
  installationId: BigInt(INSTALLATION_ID),
  role: 'viewer',
};

const JSON_CT = { 'Content-Type': 'application/json' };

// ===========================================================================
// 1. llm-keys role enforcement
// ===========================================================================

describe('llm-keys role enforcement (session mode)', () => {
  it('viewer cannot POST /integrations/llm-keys (admin required) → 403', async () => {
    currentStoreFactory = () => fakeBYOKStore();
    const { api } = makeSessionApi({
      principals: [
        {
          id: VIEWER_PRINCIPAL.id,
          username: VIEWER_PRINCIPAL.username,
          passwordHash: ADMIN_HASH,
          tokenVersion: VIEWER_PRINCIPAL.tokenVersion,
        },
      ],
      memberships: [VIEWER_MEMBERSHIP],
    });
    const jwt = await viewerJwt();
    const res = await api.request('http://host/integrations/llm-keys', {
      method: 'POST',
      headers: { Authorization: `Bearer ${jwt}`, ...JSON_CT },
      body: JSON.stringify({
        installationId: INSTALLATION_ID,
        provider: 'openai',
        apiKey: 'sk-test',
      }),
    });
    expect(res.status).toBe(403);
  });

  it('admin can POST /integrations/llm-keys → 200', async () => {
    currentStoreFactory = () => fakeBYOKStore();
    const { api } = makeSessionApi({
      principals: [
        {
          id: ADMIN_PRINCIPAL.id,
          username: ADMIN_PRINCIPAL.username,
          passwordHash: ADMIN_HASH,
          tokenVersion: ADMIN_PRINCIPAL.tokenVersion,
        },
      ],
      memberships: [ADMIN_MEMBERSHIP],
    });
    const jwt = await adminJwt();
    const res = await api.request('http://host/integrations/llm-keys', {
      method: 'POST',
      headers: { Authorization: `Bearer ${jwt}`, ...JSON_CT },
      body: JSON.stringify({
        installationId: INSTALLATION_ID,
        provider: 'openai',
        apiKey: 'sk-test',
      }),
    });
    expect(res.status).toBe(200);
  });

  it('viewer can GET /integrations/llm-keys (viewer required) → 200', async () => {
    currentStoreFactory = () => fakeBYOKStore();
    const { api } = makeSessionApi({
      principals: [
        {
          id: VIEWER_PRINCIPAL.id,
          username: VIEWER_PRINCIPAL.username,
          passwordHash: ADMIN_HASH,
          tokenVersion: VIEWER_PRINCIPAL.tokenVersion,
        },
      ],
      memberships: [VIEWER_MEMBERSHIP],
    });
    const jwt = await viewerJwt();
    const res = await api.request(
      `http://host/integrations/llm-keys?installationId=${INSTALLATION_ID}`,
      {
        headers: { Authorization: `Bearer ${jwt}` },
      },
    );
    expect(res.status).toBe(200);
  });

  it('viewer cannot DELETE /integrations/llm-keys (admin required) → 403', async () => {
    currentStoreFactory = () => fakeBYOKStore();
    const { api } = makeSessionApi({
      principals: [
        {
          id: VIEWER_PRINCIPAL.id,
          username: VIEWER_PRINCIPAL.username,
          passwordHash: ADMIN_HASH,
          tokenVersion: VIEWER_PRINCIPAL.tokenVersion,
        },
      ],
      memberships: [VIEWER_MEMBERSHIP],
    });
    const jwt = await viewerJwt();
    const res = await api.request('http://host/integrations/llm-keys', {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${jwt}`, ...JSON_CT },
      body: JSON.stringify({ installationId: INSTALLATION_ID, provider: 'openai' }),
    });
    expect(res.status).toBe(403);
  });

  it('viewer cannot POST /integrations/llm-keys/rotate (admin required) → 403', async () => {
    currentStoreFactory = () => fakeBYOKStore();
    const { api } = makeSessionApi({
      principals: [
        {
          id: VIEWER_PRINCIPAL.id,
          username: VIEWER_PRINCIPAL.username,
          passwordHash: ADMIN_HASH,
          tokenVersion: VIEWER_PRINCIPAL.tokenVersion,
        },
      ],
      memberships: [VIEWER_MEMBERSHIP],
    });
    const jwt = await viewerJwt();
    const res = await api.request('http://host/integrations/llm-keys/rotate', {
      method: 'POST',
      headers: { Authorization: `Bearer ${jwt}`, ...JSON_CT },
      body: JSON.stringify({ installationId: INSTALLATION_ID, provider: 'openai' }),
    });
    expect(res.status).toBe(403);
  });
});

// ===========================================================================
// 2. Cross-principal isolation (installation A principal cannot access B)
// ===========================================================================

describe('cross-principal isolation — llm-keys POST', () => {
  it('returns 404 when principal has no membership for the requested installationId', async () => {
    currentStoreFactory = () => fakeBYOKStore();
    // Admin on installation 42, but requests installation 999
    const { api } = makeSessionApi({
      principals: [
        {
          id: ADMIN_PRINCIPAL.id,
          username: ADMIN_PRINCIPAL.username,
          passwordHash: ADMIN_HASH,
          tokenVersion: ADMIN_PRINCIPAL.tokenVersion,
        },
      ],
      memberships: [ADMIN_MEMBERSHIP], // only installation 42
    });
    const jwt = await adminJwt();
    const res = await api.request('http://host/integrations/llm-keys', {
      method: 'POST',
      headers: { Authorization: `Bearer ${jwt}`, ...JSON_CT },
      body: JSON.stringify({
        installationId: Number(OTHER_INSTALLATION_ID_STR),
        provider: 'openai',
        apiKey: 'sk-test',
      }),
    });
    // installationAuthz: membership for installation 999 not found → 404
    expect(res.status).toBe(404);
  });

  it('returns 404 when principal has membership for installation A but requests B', async () => {
    currentStoreFactory = () => fakeBYOKStore();
    const INSTALLATION_B_ID = 777;
    const { api } = makeSessionApi({
      principals: [
        {
          id: ADMIN_PRINCIPAL.id,
          username: ADMIN_PRINCIPAL.username,
          passwordHash: ADMIN_HASH,
          tokenVersion: ADMIN_PRINCIPAL.tokenVersion,
        },
      ],
      memberships: [ADMIN_MEMBERSHIP], // only installation 42
    });
    const jwt = await adminJwt();
    const res = await api.request('http://host/integrations/llm-keys', {
      method: 'POST',
      headers: { Authorization: `Bearer ${jwt}`, ...JSON_CT },
      body: JSON.stringify({
        installationId: INSTALLATION_B_ID,
        provider: 'openai',
        apiKey: 'sk-test',
      }),
    });
    expect(res.status).toBe(404);
  });
});

// ===========================================================================
// 3. Audit actor threading
// ===========================================================================

describe('audit actor is set to principal.id for JWT-authenticated admin actions', () => {
  it('POST /integrations/llm-keys records actor=principal.id', async () => {
    const state = new Map<string, ByokKey>();
    currentStoreFactory = () => fakeBYOKStore(state);
    const { appender, records } = fakeAuditAppender();
    const { api } = makeSessionApi({
      principals: [
        {
          id: ADMIN_PRINCIPAL.id,
          username: ADMIN_PRINCIPAL.username,
          passwordHash: ADMIN_HASH,
          tokenVersion: ADMIN_PRINCIPAL.tokenVersion,
        },
      ],
      memberships: [ADMIN_MEMBERSHIP],
      auditAppender: appender,
    });
    const jwt = await adminJwt();
    await api.request('http://host/integrations/llm-keys', {
      method: 'POST',
      headers: { Authorization: `Bearer ${jwt}`, ...JSON_CT },
      body: JSON.stringify({
        installationId: INSTALLATION_ID,
        provider: 'openai',
        apiKey: 'sk-test',
      }),
    });
    expect(records.length).toBeGreaterThan(0);
    const auditRecord = records[0];
    expect(auditRecord?.event).toBe('byok.key.upsert');
    expect(auditRecord?.actor).toBe(ADMIN_PRINCIPAL.id);
  });

  it('DELETE /integrations/llm-keys records actor=principal.id', async () => {
    const state = new Map<string, ByokKey>();
    currentStoreFactory = () => fakeBYOKStore(state);
    const { appender, records } = fakeAuditAppender();
    const { api } = makeSessionApi({
      principals: [
        {
          id: ADMIN_PRINCIPAL.id,
          username: ADMIN_PRINCIPAL.username,
          passwordHash: ADMIN_HASH,
          tokenVersion: ADMIN_PRINCIPAL.tokenVersion,
        },
      ],
      memberships: [ADMIN_MEMBERSHIP],
      auditAppender: appender,
    });
    const jwt = await adminJwt();
    await api.request('http://host/integrations/llm-keys', {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${jwt}`, ...JSON_CT },
      body: JSON.stringify({ installationId: INSTALLATION_ID, provider: 'openai' }),
    });
    expect(records.length).toBeGreaterThan(0);
    const auditRecord = records[0];
    expect(auditRecord?.event).toBe('byok.key.delete');
    expect(auditRecord?.actor).toBe(ADMIN_PRINCIPAL.id);
  });
});

describe('audit actor is null for legacy (shared-token) admin actions', () => {
  it('POST /integrations/llm-keys in legacy mode records actor=undefined (omitted)', async () => {
    const state = new Map<string, ByokKey>();
    currentStoreFactory = () => fakeBYOKStore(state);
    const { appender, records } = fakeAuditAppender();
    const db = makeDb([], []);
    const api = createApi({
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      db: db as any,
      env: {},
      authMode: 'legacy',
      dashboardToken: 'legacy-token',
      kmsClient: fakeKmsClient(),
      auditAppender: appender,
      kmsKeyId: 'arn:aws:kms:us-east-1:111:key/test-cmk',
    });
    const res = await api.request('http://host/integrations/llm-keys', {
      method: 'POST',
      headers: { Authorization: 'Bearer legacy-token', ...JSON_CT },
      body: JSON.stringify({
        installationId: INSTALLATION_ID,
        provider: 'openai',
        apiKey: 'sk-test',
      }),
    });
    expect(res.status).toBe(200);
    expect(records.length).toBeGreaterThan(0);
    const auditRecord = records[0];
    expect(auditRecord?.event).toBe('byok.key.upsert');
    // Legacy path: actor property should be absent (undefined) or null, not a principal id
    expect(auditRecord?.actor ?? null).toBeNull();
  });
});

// ===========================================================================
// 4. Legacy regression — existing endpoints unchanged
// ===========================================================================

describe('legacy regression — no principal, multiTenant=false', () => {
  it('GET /integrations/llm-keys passes through in legacy mode', async () => {
    currentStoreFactory = () => fakeBYOKStore();
    const { api } = makeLegacyApi();
    const res = await api.request(
      `http://host/integrations/llm-keys?installationId=${INSTALLATION_ID}`,
      {
        headers: { Authorization: 'Bearer legacy-token' },
      },
    );
    expect(res.status).toBe(200);
  });

  it('POST /integrations/llm-keys passes through in legacy mode', async () => {
    currentStoreFactory = () => fakeBYOKStore();
    const { api } = makeLegacyApi();
    const res = await api.request('http://host/integrations/llm-keys', {
      method: 'POST',
      headers: { Authorization: 'Bearer legacy-token', ...JSON_CT },
      body: JSON.stringify({ installationId: INSTALLATION_ID, provider: 'openai', apiKey: 'sk-x' }),
    });
    expect(res.status).toBe(200);
  });

  it('legacy mode without token → 401 (unchanged)', async () => {
    currentStoreFactory = () => fakeBYOKStore();
    const { api } = makeLegacyApi();
    const res = await api.request(
      `http://host/integrations/llm-keys?installationId=${INSTALLATION_ID}`,
    );
    expect(res.status).toBe(401);
  });
});

describe('legacy regression — multiTenant=true still returns 501', () => {
  it('GET /integrations/llm-keys returns 501 in multiTenant=true mode regardless of auth', async () => {
    currentStoreFactory = () => fakeBYOKStore();
    const db = makeDb([], []);
    const { appender } = fakeAuditAppender();
    const api = createApi({
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      db: db as any,
      env: {},
      authMode: 'legacy',
      dashboardToken: 'legacy-token',
      kmsClient: fakeKmsClient(),
      auditAppender: appender,
      kmsKeyId: 'arn:aws:kms:us-east-1:111:key/test-cmk',
      multiTenant: true,
    });
    const res = await api.request(
      `http://host/integrations/llm-keys?installationId=${INSTALLATION_ID}`,
      {
        headers: { Authorization: 'Bearer legacy-token' },
      },
    );
    expect(res.status).toBe(501);
  });
});

// ===========================================================================
// 5. rotate non-BYOK error rethrow (500 path)
// ===========================================================================

describe('POST /integrations/llm-keys/rotate — non-BYOK error rethrows', () => {
  it('propagates a non-BYOK error as 500', async () => {
    const throwingStore = fakeBYOKStore();
    (throwingStore.rotate as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('unexpected DB connection failure'),
    );
    currentStoreFactory = () => throwingStore;
    const { api } = makeSessionApi({
      principals: [
        {
          id: ADMIN_PRINCIPAL.id,
          username: ADMIN_PRINCIPAL.username,
          passwordHash: ADMIN_HASH,
          tokenVersion: ADMIN_PRINCIPAL.tokenVersion,
        },
      ],
      memberships: [ADMIN_MEMBERSHIP],
    });
    const jwt = await adminJwt();
    const res = await api.request('http://host/integrations/llm-keys/rotate', {
      method: 'POST',
      headers: { Authorization: `Bearer ${jwt}`, ...JSON_CT },
      body: JSON.stringify({ installationId: INSTALLATION_ID, provider: 'openai' }),
    });
    // Non-BYOK error is rethrown → Hono returns 500
    expect(res.status).toBe(500);
  });
});

// ===========================================================================
// 6. repos/bulk role enforcement (via github-repos.ts)
// ===========================================================================

// ===========================================================================
// 6. installationId resolution edge cases (body-parse failure paths)
// ===========================================================================

describe('installationId resolution — body parse failures', () => {
  it('POST /integrations/llm-keys with invalid JSON → 400 from handler (not authz)', async () => {
    // installationAuthz tries to parse body; on failure returns undefined → 400.
    // Then the handler also gets 400 on its own body parse.
    currentStoreFactory = () => fakeBYOKStore();
    const { api } = makeSessionApi({
      principals: [
        {
          id: ADMIN_PRINCIPAL.id,
          username: ADMIN_PRINCIPAL.username,
          passwordHash: ADMIN_HASH,
          tokenVersion: ADMIN_PRINCIPAL.tokenVersion,
        },
      ],
      memberships: [ADMIN_MEMBERSHIP],
    });
    const jwt = await adminJwt();
    // installationAuthz body-read returns undefined (bad JSON) → 400 installationId required
    const res = await api.request('http://host/integrations/llm-keys', {
      method: 'POST',
      headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
      body: 'not-json',
    });
    expect(res.status).toBe(400);
  });

  it('POST /integrations/llm-keys/rotate with invalid JSON → 400', async () => {
    currentStoreFactory = () => fakeBYOKStore();
    const { api } = makeSessionApi({
      principals: [
        {
          id: ADMIN_PRINCIPAL.id,
          username: ADMIN_PRINCIPAL.username,
          passwordHash: ADMIN_HASH,
          tokenVersion: ADMIN_PRINCIPAL.tokenVersion,
        },
      ],
      memberships: [ADMIN_MEMBERSHIP],
    });
    const jwt = await adminJwt();
    const res = await api.request('http://host/integrations/llm-keys/rotate', {
      method: 'POST',
      headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
      body: 'not-json',
    });
    expect(res.status).toBe(400);
  });

  it('DELETE /integrations/llm-keys with invalid JSON → 400', async () => {
    currentStoreFactory = () => fakeBYOKStore();
    const { api } = makeSessionApi({
      principals: [
        {
          id: ADMIN_PRINCIPAL.id,
          username: ADMIN_PRINCIPAL.username,
          passwordHash: ADMIN_HASH,
          tokenVersion: ADMIN_PRINCIPAL.tokenVersion,
        },
      ],
      memberships: [ADMIN_MEMBERSHIP],
    });
    const jwt = await adminJwt();
    const res = await api.request('http://host/integrations/llm-keys', {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
      body: 'not-json',
    });
    expect(res.status).toBe(400);
  });
});

describe('repos/bulk role enforcement', () => {
  it('viewer cannot POST /repos/bulk (admin required) → 403', async () => {
    const { api } = makeSessionApi({
      principals: [
        {
          id: VIEWER_PRINCIPAL.id,
          username: VIEWER_PRINCIPAL.username,
          passwordHash: ADMIN_HASH,
          tokenVersion: VIEWER_PRINCIPAL.tokenVersion,
        },
      ],
      memberships: [VIEWER_MEMBERSHIP],
    });
    const jwt = await viewerJwt();
    const res = await api.request('http://host/repos/bulk', {
      method: 'POST',
      headers: { Authorization: `Bearer ${jwt}`, ...JSON_CT },
      body: JSON.stringify({ installationId: INSTALLATION_ID, names: ['owner/repo'] }),
    });
    expect(res.status).toBe(403);
  });

  it('cross-principal: admin with no membership for requested installation → 404', async () => {
    const { api } = makeSessionApi({
      principals: [
        {
          id: ADMIN_PRINCIPAL.id,
          username: ADMIN_PRINCIPAL.username,
          passwordHash: ADMIN_HASH,
          tokenVersion: ADMIN_PRINCIPAL.tokenVersion,
        },
      ],
      memberships: [], // no membership at all
    });
    const jwt = await adminJwt();
    const res = await api.request('http://host/repos/bulk', {
      method: 'POST',
      headers: { Authorization: `Bearer ${jwt}`, ...JSON_CT },
      body: JSON.stringify({ installationId: INSTALLATION_ID, names: ['owner/repo'] }),
    });
    expect(res.status).toBe(404);
  });

  it('POST /repos/bulk with invalid JSON body → 400 (body-parse catch path)', async () => {
    const { api } = makeSessionApi({
      principals: [
        {
          id: ADMIN_PRINCIPAL.id,
          username: ADMIN_PRINCIPAL.username,
          passwordHash: ADMIN_HASH,
          tokenVersion: ADMIN_PRINCIPAL.tokenVersion,
        },
      ],
      memberships: [ADMIN_MEMBERSHIP],
    });
    const jwt = await adminJwt();
    // installationAuthz body-read catches JSON parse error → undefined → 400
    const res = await api.request('http://host/repos/bulk', {
      method: 'POST',
      headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
      body: 'not-json',
    });
    expect(res.status).toBe(400);
  });
});
