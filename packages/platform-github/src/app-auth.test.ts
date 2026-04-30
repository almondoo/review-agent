import { describe, expect, it, vi } from 'vitest';
import { type AppAuthEnv, createAppAuthClient, loadPrivateKey } from './app-auth.js';

describe('loadPrivateKey precedence', () => {
  it('rejects when no source is set', async () => {
    await expect(loadPrivateKey({})).rejects.toThrow(/No GitHub App private key source set/);
  });

  it('rejects when multiple sources are set', async () => {
    const env: AppAuthEnv = {
      GITHUB_APP_PRIVATE_KEY_PEM: 'PEM',
      GITHUB_APP_PRIVATE_KEY_PATH: '/tmp/key.pem',
    };
    await expect(loadPrivateKey(env)).rejects.toThrow(/Multiple GitHub App private key sources/);
  });

  it('returns inline PEM in non-production', async () => {
    const env: AppAuthEnv = { GITHUB_APP_PRIVATE_KEY_PEM: 'PEM-CONTENT', NODE_ENV: 'development' };
    const r = await loadPrivateKey(env);
    expect(r).toEqual({ source: '_PEM', pem: 'PEM-CONTENT' });
  });

  it('refuses inline PEM in production without override', async () => {
    const env: AppAuthEnv = { GITHUB_APP_PRIVATE_KEY_PEM: 'PEM', NODE_ENV: 'production' };
    await expect(loadPrivateKey(env)).rejects.toThrow(/refused in production/);
  });

  it('allows inline PEM in production with REVIEW_AGENT_ALLOW_INLINE_KEY=1', async () => {
    const env: AppAuthEnv = {
      GITHUB_APP_PRIVATE_KEY_PEM: 'PEM',
      NODE_ENV: 'production',
      REVIEW_AGENT_ALLOW_INLINE_KEY: '1',
    };
    const r = await loadPrivateKey(env);
    expect(r.source).toBe('_PEM');
  });

  it('reads PATH via injected reader', async () => {
    const readPemFile = vi.fn().mockResolvedValue('FROM-DISK');
    const r = await loadPrivateKey(
      { GITHUB_APP_PRIVATE_KEY_PATH: '/secret/key.pem' },
      { readPemFile },
    );
    expect(r).toEqual({ source: '_PATH', pem: 'FROM-DISK' });
    expect(readPemFile).toHaveBeenCalledWith('/secret/key.pem');
  });

  it('fetches ARN via injected aws fetcher', async () => {
    const fetchAwsSecret = vi.fn().mockResolvedValue('AWS-PEM');
    const r = await loadPrivateKey(
      { GITHUB_APP_PRIVATE_KEY_ARN: 'arn:aws:secretsmanager:us-east-1:1:secret:k' },
      { fetchAwsSecret },
    );
    expect(r).toEqual({ source: '_ARN', pem: 'AWS-PEM' });
    expect(fetchAwsSecret).toHaveBeenCalledOnce();
  });

  it('fetches RESOURCE via injected gcp fetcher', async () => {
    const fetchGcpSecret = vi.fn().mockResolvedValue('GCP-PEM');
    const r = await loadPrivateKey(
      { GITHUB_APP_PRIVATE_KEY_RESOURCE: 'projects/p/secrets/s/versions/latest' },
      { fetchGcpSecret },
    );
    expect(r).toEqual({ source: '_RESOURCE', pem: 'GCP-PEM' });
  });
});

type MockedDb = {
  rows: Map<bigint, { token: string; expiresAt: Date }>;
  select: () => { from: () => { where: () => { limit: () => Promise<unknown[]> } } };
  insert: () => { values: (v: unknown) => { onConflictDoUpdate: (cfg: unknown) => Promise<void> } };
  delete: () => { where: () => Promise<void> };
};

function makeMockDb(): MockedDb {
  // Simplified single-tenant mock: tests pin one installationId per test, so
  // we don't need to parse drizzle's eq() condition objects. The mock keeps
  // a single keyed entry and returns it from any .where().limit() call.
  const rows = new Map<bigint, { token: string; expiresAt: Date }>();
  return {
    rows,
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => {
            const entries = [...rows.entries()];
            const first = entries[0];
            if (!first) return [];
            return [
              {
                installationId: first[0],
                token: first[1].token,
                expiresAt: first[1].expiresAt,
                updatedAt: new Date(),
              },
            ];
          },
        }),
      }),
    }),
    insert: () => ({
      values: (v: unknown) => {
        const value = v as { installationId: bigint; token: string; expiresAt: Date };
        return {
          onConflictDoUpdate: async () => {
            rows.set(value.installationId, { token: value.token, expiresAt: value.expiresAt });
          },
        };
      },
    }),
    delete: () => ({
      where: async () => {
        rows.clear();
      },
    }),
  };
}

describe('createAppAuthClient cache lifecycle', () => {
  const installationId = 42n;

  it('mints on miss and caches', async () => {
    const db = makeMockDb();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    const mintToken = vi.fn().mockResolvedValue({ token: 'tok-1', expiresAt });
    const client = createAppAuthClient({
      appId: 1,
      privateKeyPem: 'pem',
      // biome-ignore lint/suspicious/noExplicitAny: mock surface
      db: db as any,
      mintToken,
    });
    const t1 = await client.getInstallationToken(installationId);
    expect(t1.token).toBe('tok-1');
    expect(db.rows.get(installationId)?.token).toBe('tok-1');
    expect(mintToken).toHaveBeenCalledOnce();
  });

  it('returns cached token when within TTL window', async () => {
    const db = makeMockDb();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    db.rows.set(installationId, { token: 'cached', expiresAt });
    const mintToken = vi.fn();
    const client = createAppAuthClient({
      appId: 1,
      privateKeyPem: 'pem',
      // biome-ignore lint/suspicious/noExplicitAny: mock surface
      db: db as any,
      mintToken,
    });
    const t = await client.getInstallationToken(installationId);
    expect(t.token).toBe('cached');
    expect(mintToken).not.toHaveBeenCalled();
  });

  it('refetches when cached token is within 5min refresh window', async () => {
    const db = makeMockDb();
    const expiresAt = new Date(Date.now() + 60 * 1000); // 1 min from now
    db.rows.set(installationId, { token: 'almost-stale', expiresAt });
    const fresh = { token: 'fresh', expiresAt: new Date(Date.now() + 60 * 60 * 1000) };
    const mintToken = vi.fn().mockResolvedValue(fresh);
    const client = createAppAuthClient({
      appId: 1,
      privateKeyPem: 'pem',
      // biome-ignore lint/suspicious/noExplicitAny: mock surface
      db: db as any,
      mintToken,
    });
    const t = await client.getInstallationToken(installationId);
    expect(t.token).toBe('fresh');
    expect(mintToken).toHaveBeenCalledOnce();
  });

  it('invalidate removes the cached token', async () => {
    const db = makeMockDb();
    db.rows.set(installationId, { token: 't', expiresAt: new Date(Date.now() + 60 * 60 * 1000) });
    const client = createAppAuthClient({
      appId: 1,
      privateKeyPem: 'pem',
      // biome-ignore lint/suspicious/noExplicitAny: mock surface
      db: db as any,
      mintToken: vi.fn(),
    });
    await client.invalidate(installationId);
    expect(db.rows.has(installationId)).toBe(false);
  });
});
