/**
 * Tests for /github/install-redirect and /github/setup routes.
 *
 * All 8 branches covered:
 *   1. slug-unset → 503
 *   2. happy install-redirect → 302 + Set-Cookie (state replayed as Cookie on setup)
 *   3. malformed/missing query params → 302 to ${dashboardOrigin}/integrations?error=validation_error
 *   4. missing cookie → 302 to ${dashboardOrigin}/integrations?error=missing_state_cookie
 *   5. state mismatch → 302 to ${dashboardOrigin}/integrations?error=state_mismatch
 *   6. setup_action=request → redirect without upsert to ${dashboardOrigin}/integrations/github?error=pending_admin_approval
 *   7. happy install → upsert + redirect to ${dashboardOrigin}/integrations/github/repos?installation_id=<id>
 *   8. DB error → redirect to ${dashboardOrigin}/integrations?error=setup_failed
 *
 * Uses vi.mock('@review-agent/db') to replace withTenant with a controllable fake.
 * The fetchInstallation dep is injected directly so no @octokit/rest calls are made.
 */
import type { AuditAppender } from '@review-agent/db';
import { describe, expect, it, vi } from 'vitest';
import type { InstallationInfo } from '../github-setup.js';
import { createGithubRouter } from '../github-setup.js';

// ---------------------------------------------------------------------------
// Mock @review-agent/db — replace withTenant with a controllable fake.
// The mock calls db.transaction(fn) so that fn receives the tx spy from fakeDb,
// enabling assertions on insert/update calls. When withTenantError is set the
// mock throws directly (simulating a DB failure) without calling fn.
// ---------------------------------------------------------------------------
let withTenantError: Error | null = null;

vi.mock('@review-agent/db', async () => {
  const actual = await vi.importActual<typeof import('@review-agent/db')>('@review-agent/db');
  return {
    ...actual,
    withTenant: async (
      db: { transaction: (fn: (tx: unknown) => Promise<unknown>) => Promise<unknown> },
      _installationId: unknown,
      fn: (tx: unknown) => Promise<unknown>,
    ) => {
      if (withTenantError !== null) throw withTenantError;
      return db.transaction(fn);
    },
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function fakeDb() {
  const insertMock = vi.fn().mockReturnValue({
    values: vi.fn().mockReturnValue({
      onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
    }),
  });
  const tx = { insert: insertMock };
  return {
    transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(tx)),
    insert: insertMock,
    _insertMock: insertMock,
  };
}

function fakeAuthClient() {
  return {
    getInstallationToken: vi.fn(),
    invalidate: vi.fn(),
    createAppJwt: vi.fn().mockResolvedValue('app.jwt.token'),
  };
}

const defaultFetchInstallation = vi.fn(
  async (_opts: unknown): Promise<InstallationInfo> => ({
    accountLogin: 'test-org',
    accountType: 'Organization',
    appId: 42n,
  }),
);

function makeRouter(opts: {
  githubAppSlug?: string;
  dashboardOrigin?: string;
  withAuth?: boolean;
}) {
  // biome-ignore lint/suspicious/noExplicitAny: test mock
  const db = fakeDb() as any;
  const authClient = fakeAuthClient();

  return {
    router: createGithubRouter({
      db,
      ...(opts.githubAppSlug !== undefined ? { githubAppSlug: opts.githubAppSlug } : {}),
      ...(opts.dashboardOrigin !== undefined ? { dashboardOrigin: opts.dashboardOrigin } : {}),
      ...(opts.withAuth !== false ? { github: { appAuthClient: authClient } } : {}),
      fetchInstallation: defaultFetchInstallation,
    }),
    db,
    authClient,
  };
}

// Extract Set-Cookie header value from response; returns null if absent.
function extractStateCookie(res: Response): string | null {
  const raw = res.headers.get('set-cookie');
  if (!raw) return null;
  // Set-Cookie: github_install_state=<value>; Path=/; ...
  const match = raw.match(/github_install_state=([^;]+)/);
  return match ? `github_install_state=${match[1]}` : null;
}

// Extract the state UUID from a Cookie header string.
function extractStateValue(cookieHeader: string): string {
  const match = cookieHeader.match(/github_install_state=([^;]+)/);
  return match?.[1] ?? '';
}

// Obtain a real CSRF state/cookie pair by calling install-redirect.
async function getStateAndCookie(
  router: ReturnType<typeof createGithubRouter>,
): Promise<{ cookieHeader: string; stateValue: string }> {
  const redirectRes = await router.request('http://host/install-redirect');
  const cookieHeader = extractStateCookie(redirectRes);
  if (!cookieHeader) throw new Error('install-redirect did not set a cookie');
  const stateValue = extractStateValue(cookieHeader);
  return { cookieHeader, stateValue };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('GET /install-redirect', () => {
  it('branch 1: returns 503 when githubAppSlug is not set', async () => {
    const { router } = makeRouter({ dashboardOrigin: 'https://dash.example.com' });
    const res = await router.request('http://host/install-redirect');
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toMatchObject({ error: 'github_app_not_configured' });
  });

  it('branch 1b: returns 503 when dashboardOrigin is not set', async () => {
    const { router } = makeRouter({ githubAppSlug: 'my-review-agent' });
    const res = await router.request('http://host/install-redirect');
    expect(res.status).toBe(503);
  });

  it('branch 2: returns 302 to GitHub and sets CSRF state cookie', async () => {
    const { router } = makeRouter({
      githubAppSlug: 'my-review-agent',
      dashboardOrigin: 'https://dash.example.com',
    });
    const res = await router.request('http://host/install-redirect');
    expect(res.status).toBe(302);

    const location = res.headers.get('location') ?? '';
    expect(location).toMatch(
      /^https:\/\/github\.com\/apps\/my-review-agent\/installations\/new\?state=/,
    );

    // Cookie must be set with required attributes.
    const setCookieHeader = res.headers.get('set-cookie') ?? '';
    expect(setCookieHeader).toContain('github_install_state=');
    expect(setCookieHeader.toLowerCase()).toContain('httponly');
    expect(setCookieHeader.toLowerCase()).toContain('samesite=lax');
    expect(setCookieHeader).toContain('Max-Age=600');
    expect(setCookieHeader.toLowerCase()).toContain('secure');

    // State in redirect URL must match cookie value.
    const stateInUrl = new URL(location).searchParams.get('state');
    const stateInCookie = extractStateValue(setCookieHeader);
    expect(stateInUrl).toBe(stateInCookie);
    expect(stateInUrl).toHaveLength(36); // UUID
  });
});

describe('GET /setup', () => {
  it('branch 3: redirects to validation_error when setup_action is missing', async () => {
    const { router } = makeRouter({
      githubAppSlug: 'my-review-agent',
      dashboardOrigin: 'https://dash.example.com',
    });
    const res = await router.request('http://host/setup?installation_id=12345&state=abc', {
      headers: { cookie: 'github_install_state=abc' },
    });
    expect(res.status).toBe(302);
    const location = res.headers.get('location') ?? '';
    expect(location).toBe('https://dash.example.com/integrations?error=validation_error');
  });

  it('branch 3b: redirects to validation_error for invalid setup_action value', async () => {
    const { router } = makeRouter({
      githubAppSlug: 'my-review-agent',
      dashboardOrigin: 'https://dash.example.com',
    });
    const res = await router.request(
      'http://host/setup?installation_id=12345&setup_action=bad&state=abc',
      { headers: { cookie: 'github_install_state=abc' } },
    );
    expect(res.status).toBe(302);
    const location = res.headers.get('location') ?? '';
    expect(location).toBe('https://dash.example.com/integrations?error=validation_error');
  });

  it('branch 4: redirects to missing_state_cookie when state cookie is absent', async () => {
    const { router } = makeRouter({
      githubAppSlug: 'my-review-agent',
      dashboardOrigin: 'https://dash.example.com',
    });
    const res = await router.request(
      'http://host/setup?installation_id=12345&setup_action=install&state=somestate',
    );
    expect(res.status).toBe(302);
    const location = res.headers.get('location') ?? '';
    expect(location).toBe('https://dash.example.com/integrations?error=missing_state_cookie');
  });

  it('branch 5: redirects to state_mismatch when state does not match cookie', async () => {
    const { router } = makeRouter({
      githubAppSlug: 'my-review-agent',
      dashboardOrigin: 'https://dash.example.com',
    });
    const res = await router.request(
      'http://host/setup?installation_id=12345&setup_action=install&state=wrong-state',
      { headers: { cookie: 'github_install_state=correct-state' } },
    );
    expect(res.status).toBe(302);
    const location = res.headers.get('location') ?? '';
    expect(location).toBe('https://dash.example.com/integrations?error=state_mismatch');
  });

  it('branch 6: setup_action=request redirects to pending_admin_approval without upserting', async () => {
    const { router, db } = makeRouter({
      githubAppSlug: 'my-review-agent',
      dashboardOrigin: 'https://dash.example.com',
    });

    // Obtain real CSRF state by calling install-redirect.
    const { cookieHeader, stateValue } = await getStateAndCookie(router);

    const res = await router.request(`http://host/setup?setup_action=request&state=${stateValue}`, {
      headers: { cookie: cookieHeader },
    });
    expect(res.status).toBe(302);
    const location = res.headers.get('location') ?? '';
    expect(location).toBe(
      'https://dash.example.com/integrations/github?error=pending_admin_approval',
    );

    // No DB upsert should have happened.
    expect(db._insertMock).not.toHaveBeenCalled();
  });

  it('branch 7: happy path — upserts and redirects to repos page', async () => {
    withTenantError = null;
    defaultFetchInstallation.mockResolvedValueOnce({
      accountLogin: 'happy-org',
      accountType: 'Organization',
      appId: 99n,
    });

    const { router, db } = makeRouter({
      githubAppSlug: 'my-review-agent',
      dashboardOrigin: 'https://dash.example.com',
    });

    const { cookieHeader, stateValue } = await getStateAndCookie(router);

    const res = await router.request(
      `http://host/setup?installation_id=99001&setup_action=install&state=${stateValue}`,
      { headers: { cookie: cookieHeader } },
    );
    expect(res.status).toBe(302);
    const location = res.headers.get('location') ?? '';
    expect(location).toBe(
      'https://dash.example.com/integrations/github/repos?installation_id=99001',
    );

    // fetchInstallation must have been called with the installationId.
    expect(defaultFetchInstallation).toHaveBeenCalledWith(
      expect.objectContaining({ installationId: 99001n }),
    );

    // DB upsert must have been executed — the core AC of this endpoint.
    expect(db._insertMock).toHaveBeenCalled();

    // State cookie should be cleared (Max-Age=0).
    const setCookieHeader = res.headers.get('set-cookie') ?? '';
    expect(setCookieHeader).toContain('github_install_state=');
    expect(setCookieHeader).toContain('Max-Age=0');
  });

  it('branch 7b: update action also upserts and redirects', async () => {
    withTenantError = null;
    const { router } = makeRouter({
      githubAppSlug: 'my-review-agent',
      dashboardOrigin: 'https://dash.example.com',
    });

    const { cookieHeader, stateValue } = await getStateAndCookie(router);

    const res = await router.request(
      `http://host/setup?installation_id=88002&setup_action=update&state=${stateValue}`,
      { headers: { cookie: cookieHeader } },
    );
    expect(res.status).toBe(302);
    const location = res.headers.get('location') ?? '';
    expect(location).toContain('installation_id=88002');
  });

  it('branch 7c: install action without installation_id → setup_failed redirect', async () => {
    withTenantError = null;
    const { router, db } = makeRouter({
      githubAppSlug: 'my-review-agent',
      dashboardOrigin: 'https://dash.example.com',
    });

    const { cookieHeader, stateValue } = await getStateAndCookie(router);

    // setup_action=install with no installation_id — Zod schema allows optional installation_id
    const res = await router.request(`http://host/setup?setup_action=install&state=${stateValue}`, {
      headers: { cookie: cookieHeader },
    });
    expect(res.status).toBe(302);
    const location = res.headers.get('location') ?? '';
    expect(location).toBe('https://dash.example.com/integrations?error=setup_failed');

    // No DB upsert should have occurred.
    expect(db._insertMock).not.toHaveBeenCalled();
  });

  it('branch 8: DB error → redirects to setup_failed', async () => {
    withTenantError = new Error('DB connection lost');

    const { router } = makeRouter({
      githubAppSlug: 'my-review-agent',
      dashboardOrigin: 'https://dash.example.com',
    });

    const { cookieHeader, stateValue } = await getStateAndCookie(router);

    const res = await router.request(
      `http://host/setup?installation_id=77003&setup_action=install&state=${stateValue}`,
      { headers: { cookie: cookieHeader } },
    );
    expect(res.status).toBe(302);
    const location = res.headers.get('location') ?? '';
    expect(location).toBe('https://dash.example.com/integrations?error=setup_failed');

    // Reset for subsequent tests.
    withTenantError = null;
  });
});

// ---------------------------------------------------------------------------
// Audit write tests
// ---------------------------------------------------------------------------

describe('GET /setup — audit', () => {
  type AuditRecord = Parameters<AuditAppender>[0];

  function fakeAuditAppender(): { appender: AuditAppender; records: AuditRecord[] } {
    const records: AuditRecord[] = [];
    const appender: AuditAppender = vi.fn(async (ev) => {
      records.push(ev);
      return { ...ev, ts: new Date(), prevHash: '0'.repeat(64), hash: '0'.repeat(64) };
    });
    return { appender, records };
  }

  it('audit write failure is best-effort (does not fail the setup redirect)', async () => {
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    const db = fakeDb() as any;
    const failingAppender: AuditAppender = vi.fn().mockRejectedValue(new Error('audit fail'));

    const router = createGithubRouter({
      db,
      githubAppSlug: 'my-review-agent',
      dashboardOrigin: 'https://dash.example.com',
      fetchInstallation: defaultFetchInstallation,
      auditAppender: failingAppender,
    });

    const { cookieHeader, stateValue } = await getStateAndCookie(router);
    const res = await router.request(
      `http://host/setup?installation_id=99999&setup_action=install&state=${stateValue}`,
      { headers: { cookie: cookieHeader } },
    );
    // The redirect should still succeed despite the audit write failure
    expect(res.status).toBe(302);
    const location = res.headers.get('location') ?? '';
    expect(location).toContain('/integrations/github/repos');
  });

  it('writes github_installation.setup audit event on successful install', async () => {
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    const db = fakeDb() as any;
    const { appender, records } = fakeAuditAppender();

    const router = createGithubRouter({
      db,
      githubAppSlug: 'my-review-agent',
      dashboardOrigin: 'https://dash.example.com',
      fetchInstallation: defaultFetchInstallation,
      auditAppender: appender,
    });

    const { cookieHeader, stateValue } = await getStateAndCookie(router);
    const res = await router.request(
      `http://host/setup?installation_id=12345&setup_action=install&state=${stateValue}`,
      { headers: { cookie: cookieHeader } },
    );
    expect(res.status).toBe(302);
    expect(records).toHaveLength(1);
    const ev = records[0];
    expect(ev?.event).toBe('github_installation.setup');
    expect(ev?.resourceType).toBe('github_installation');
    expect(ev?.resourceId).toBe('12345');
    expect(ev?.installationId).toBe(12345n);
    // actor must be null (no JWT principal on this endpoint)
    expect(ev?.actor).toBeUndefined();
  });
});
