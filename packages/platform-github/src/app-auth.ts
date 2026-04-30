import { readFile } from 'node:fs/promises';
import { createAppAuth } from '@octokit/auth-app';
import { installationTokens } from '@review-agent/core/db';
import type { DbClient } from '@review-agent/db';
import { eq } from 'drizzle-orm';

const SOURCES = ['_PEM', '_PATH', '_ARN', '_RESOURCE'] as const;
export type PrivateKeySource = (typeof SOURCES)[number];

export type AppAuthEnv = {
  readonly GITHUB_APP_ID?: string;
  readonly GITHUB_APP_PRIVATE_KEY_PEM?: string;
  readonly GITHUB_APP_PRIVATE_KEY_PATH?: string;
  readonly GITHUB_APP_PRIVATE_KEY_ARN?: string;
  readonly GITHUB_APP_PRIVATE_KEY_RESOURCE?: string;
  readonly REVIEW_AGENT_ALLOW_INLINE_KEY?: string;
  readonly NODE_ENV?: string;
};

export type SecretFetchers = {
  readonly fetchAwsSecret?: (arn: string) => Promise<string>;
  readonly fetchGcpSecret?: (resource: string) => Promise<string>;
  readonly readPemFile?: (path: string) => Promise<string>;
};

/* v8 ignore start -- default fetchers wrap external SDKs; covered by integration tests */
const defaultReadPemFile = (path: string): Promise<string> => readFile(path, 'utf8');

const defaultAwsFetcher = async (arn: string): Promise<string> => {
  const { SecretsManagerClient, GetSecretValueCommand } = await import(
    '@aws-sdk/client-secrets-manager'
  );
  const region = arn.split(':')[3];
  const client = new SecretsManagerClient(region ? { region } : {});
  const out = await client.send(new GetSecretValueCommand({ SecretId: arn }));
  if (!out.SecretString) {
    throw new Error(`Secrets Manager ARN ${arn} returned no SecretString`);
  }
  return out.SecretString;
};

const defaultGcpFetcher = async (resource: string): Promise<string> => {
  const { SecretManagerServiceClient } = await import('@google-cloud/secret-manager');
  const client = new SecretManagerServiceClient();
  const [version] = await client.accessSecretVersion({ name: resource });
  const payload = version.payload?.data;
  if (!payload) {
    throw new Error(`GCP Secret Manager resource ${resource} returned empty payload`);
  }
  return Buffer.isBuffer(payload) ? payload.toString('utf8') : String(payload);
};
/* v8 ignore stop */

export type LoadPrivateKeyResult = {
  readonly source: PrivateKeySource;
  readonly pem: string;
};

export async function loadPrivateKey(
  env: AppAuthEnv,
  fetchers: SecretFetchers = {},
): Promise<LoadPrivateKeyResult> {
  const present = SOURCES.filter((s) => readEnv(env, s));
  if (present.length === 0) {
    throw new Error(
      'No GitHub App private key source set. Set exactly one of GITHUB_APP_PRIVATE_KEY_PEM, GITHUB_APP_PRIVATE_KEY_PATH, GITHUB_APP_PRIVATE_KEY_ARN, GITHUB_APP_PRIVATE_KEY_RESOURCE (Appendix B).',
    );
  }
  if (present.length > 1) {
    throw new Error(
      `Multiple GitHub App private key sources set: ${present.join(', ')}. Set exactly one (Appendix B).`,
    );
  }
  const source = present[0];
  /* v8 ignore next -- defensive: present.length already validated above */
  if (!source) throw new Error('unreachable: present.length checked above');
  const value = readEnv(env, source);
  /* v8 ignore next -- defensive: source was filtered by readEnv truthiness above */
  if (value === undefined) throw new Error(`unreachable: ${source} env was filtered as set`);

  if (source === '_PEM') {
    const isProd = (env.NODE_ENV ?? 'development') === 'production';
    const allowInline = env.REVIEW_AGENT_ALLOW_INLINE_KEY === '1';
    if (isProd && !allowInline) {
      throw new Error(
        'GITHUB_APP_PRIVATE_KEY_PEM is refused in production. Set REVIEW_AGENT_ALLOW_INLINE_KEY=1 to override (NOT recommended).',
      );
    }
    return { source, pem: value };
  }

  if (source === '_PATH') {
    const read = fetchers.readPemFile ?? defaultReadPemFile;
    return { source, pem: await read(value) };
  }

  if (source === '_ARN') {
    const fetch = fetchers.fetchAwsSecret ?? defaultAwsFetcher;
    return { source, pem: await fetch(value) };
  }

  const fetch = fetchers.fetchGcpSecret ?? defaultGcpFetcher;
  return { source, pem: await fetch(value) };
}

function readEnv(env: AppAuthEnv, source: PrivateKeySource): string | undefined {
  switch (source) {
    case '_PEM':
      return env.GITHUB_APP_PRIVATE_KEY_PEM;
    case '_PATH':
      return env.GITHUB_APP_PRIVATE_KEY_PATH;
    case '_ARN':
      return env.GITHUB_APP_PRIVATE_KEY_ARN;
    case '_RESOURCE':
      return env.GITHUB_APP_PRIVATE_KEY_RESOURCE;
  }
}

export type InstallationToken = {
  readonly token: string;
  readonly expiresAt: Date;
};

export type AppAuthClient = {
  getInstallationToken(installationId: bigint): Promise<InstallationToken>;
  invalidate(installationId: bigint): Promise<void>;
};

export type CreateAppAuthOpts = {
  readonly appId: string | number;
  readonly privateKeyPem: string;
  readonly db: DbClient;
  readonly now?: () => Date;
  readonly clockSkewMs?: number;
  readonly mintToken?: (installationId: bigint) => Promise<InstallationToken>;
};

const REFRESH_WINDOW_MS = 5 * 60 * 1000;

export function createAppAuthClient(opts: CreateAppAuthOpts): AppAuthClient {
  const now = opts.now ?? (() => new Date());
  const skew = opts.clockSkewMs ?? 0;
  const auth = createAppAuth({ appId: opts.appId, privateKey: opts.privateKeyPem });
  const mintToken =
    opts.mintToken ??
    /* v8 ignore start -- default mintToken hits @octokit/auth-app live; covered by integration tests */
    (async (installationId: bigint): Promise<InstallationToken> => {
      const r = await auth({
        type: 'installation',
        installationId: Number(installationId),
      });
      return { token: r.token, expiresAt: new Date(r.expiresAt) };
    });
  /* v8 ignore stop */

  async function readCached(installationId: bigint): Promise<InstallationToken | null> {
    const rows = await opts.db
      .select()
      .from(installationTokens)
      .where(eq(installationTokens.installationId, installationId))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    const ttlEnd = row.expiresAt.getTime() - REFRESH_WINDOW_MS;
    if (ttlEnd <= now().getTime() + skew) return null;
    return { token: row.token, expiresAt: row.expiresAt };
  }

  async function persist(installationId: bigint, t: InstallationToken): Promise<void> {
    await opts.db
      .insert(installationTokens)
      .values({ installationId, token: t.token, expiresAt: t.expiresAt })
      .onConflictDoUpdate({
        target: installationTokens.installationId,
        set: { token: t.token, expiresAt: t.expiresAt, updatedAt: now() },
      });
  }

  return {
    async getInstallationToken(installationId) {
      const cached = await readCached(installationId);
      if (cached) return cached;
      const fresh = await mintToken(installationId);
      await persist(installationId, fresh);
      return fresh;
    },
    async invalidate(installationId) {
      await opts.db
        .delete(installationTokens)
        .where(eq(installationTokens.installationId, installationId));
    },
  };
}
