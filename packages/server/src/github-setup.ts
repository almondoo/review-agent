/**
 * /github/install-redirect and /github/setup — GitHub App onboarding endpoints.
 *
 * These routes sit OUTSIDE the /api/* bearer-token guard (spec §8.2.2).
 * CSRF via state cookie is the sole authentication mechanism for /github/setup.
 *
 * Flow (spec §8.2.2):
 *   1. Dashboard calls GET /github/install-redirect
 *      → mints randomUUID() state, sets HttpOnly Secure SameSite=Lax Max-Age=600 cookie
 *      → redirects to https://github.com/apps/<slug>/installations/new?state=<token>
 *   2. GitHub redirects back to GET /github/setup?installation_id=<id>&setup_action=<action>&state=<token>
 *      → validates state against cookie via timingSafeEqual (constant-time, dummy-buffer)
 *      → if setup_action==="request": redirect to dashboard without upserting
 *      → else: enrich via octokit apps.getInstallation (App JWT), upsert via withTenant, redirect to dashboard
 */
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { githubInstallations } from '@review-agent/core/db';
import { type AuditAppender, type DbClient, withTenant } from '@review-agent/db';
import type { AppAuthClient } from '@review-agent/platform-github';
import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';

/**
 * Minimal shape of the GitHub installation data returned by apps.getInstallation.
 * Used for injection in tests and to avoid a direct @octokit/rest runtime import
 * in this package (platform-github owns that dependency).
 */
export type InstallationInfo = {
  readonly accountLogin: string;
  readonly accountType: string;
  readonly appId: bigint;
};

/**
 * Fetches installation information using an App-level JWT.
 * Injected via deps so tests can substitute a stub without requiring @octokit/rest.
 */
export type FetchInstallationFn = (opts: {
  readonly installationId: bigint;
  readonly appAuthClient: AppAuthClient;
}) => Promise<InstallationInfo>;

/**
 * Default implementation: fetches installation info via App-level JWT from Octokit.
 * Uses a static import for @octokit/rest (listed as a direct dep in package.json
 * to pin the same version as platform-github and avoid NodeNext ESM mismatch).
 *
 * This function is v8-ignored because it hits live Octokit; covered by integration tests.
 */
/* v8 ignore start */
const defaultFetchInstallation: FetchInstallationFn = async ({ installationId, appAuthClient }) => {
  const { Octokit } = await import('@octokit/rest');
  const jwt = await appAuthClient.createAppJwt();
  const octokit = new Octokit({ auth: jwt });
  const { data } = await octokit.apps.getInstallation({
    installation_id: Number(installationId),
  });
  // `account` is a union of user / organization / enterprise-type objects.
  // Only user/organization shapes carry `login` and `type`; narrow via 'in'.
  const account = data.account;
  const accountLogin =
    account !== null && account !== undefined && 'login' in account ? (account.login ?? '') : '';
  const accountType =
    account !== null && account !== undefined && 'type' in account
      ? String(account.type ?? '')
      : '';
  return {
    accountLogin,
    accountType,
    appId: BigInt(data.app_id),
  };
};
/* v8 ignore stop */

const STATE_COOKIE = 'github_install_state';
const STATE_MAX_AGE = 600;

export type GithubRouterDeps = {
  /**
   * URL-safe GitHub App slug (e.g. "my-review-agent").
   * When absent, install-redirect returns 503.
   */
  readonly githubAppSlug?: string;
  /**
   * Origin of the dashboard (e.g. "https://dashboard.example.com").
   * Redirected to after setup completes.
   * When absent, install-redirect returns 503.
   */
  readonly dashboardOrigin?: string;
  /**
   * App-level auth client (from platform-github).
   * Provides createAppJwt() for calls to apps.getInstallation.
   */
  readonly github?: {
    readonly appAuthClient: AppAuthClient;
  };
  /**
   * Optional override for fetching GitHub installation info.
   * When unset, the default implementation calls Octokit via the appAuthClient.
   * Tests inject a stub here to avoid requiring @octokit/rest.
   */
  readonly fetchInstallation?: FetchInstallationFn;
  /**
   * Database client for upserting github_installations via withTenant.
   */
  readonly db: DbClient;
  /**
   * Optional audit appender. When present, installation upserts are recorded.
   * actor is null because /github/setup uses CSRF-only authentication (no JWT principal).
   */
  readonly auditAppender?: AuditAppender;
};

const setupQuerySchema = z.object({
  installation_id: z.string().regex(/^\d+$/, 'installation_id must be a numeric string').optional(),
  setup_action: z.enum(['install', 'update', 'request']),
  state: z.string().min(1, 'state is required'),
});

/**
 * Constant-time state comparison. Always runs timingSafeEqual even when
 * lengths differ (dummy buffer) to avoid length-based timing side-channels.
 * Pattern identical to packages/server/src/api/middleware/auth.ts:55-68.
 */
function compareState(provided: string, expected: string): boolean {
  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(expected);
  if (providedBuf.length !== expectedBuf.length) {
    const dummy = Buffer.alloc(providedBuf.length);
    timingSafeEqual(providedBuf, dummy);
    return false;
  }
  return timingSafeEqual(providedBuf, expectedBuf);
}

export function createGithubRouter(deps: GithubRouterDeps): Hono {
  const app = new Hono();

  /**
   * GET /install-redirect
   *
   * Mints a random CSRF state token, sets a signed cookie, and redirects
   * to the GitHub App installation page.
   *
   * Returns 503 when GITHUB_APP_SLUG or dashboardOrigin is not configured.
   */
  app.get('/install-redirect', (c) => {
    const slug = deps.githubAppSlug;
    const dashboardOrigin = deps.dashboardOrigin;
    if (!slug || slug.length === 0 || !dashboardOrigin || dashboardOrigin.length === 0) {
      return c.json({ error: 'github_app_not_configured' }, 503);
    }

    const state = randomUUID();

    // SameSite=Lax: GitHub redirects back via a cross-site top-level GET.
    // Lax allows the cookie to be sent on these navigations (spec §8.2.2).
    setCookie(c, STATE_COOKIE, state, {
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
      maxAge: STATE_MAX_AGE,
      path: '/',
    });

    const installUrl = `https://github.com/apps/${slug}/installations/new?state=${state}`;
    return c.redirect(installUrl, 302);
  });

  /**
   * GET /setup
   *
   * GitHub's redirect target after installation. Validates state, upserts
   * the installation row, clears the cookie, and redirects to the dashboard.
   *
   * Never returns a JSON body — only redirects (spec §8.2.2 note).
   */
  app.get('/setup', async (c) => {
    const dashboardOrigin = deps.dashboardOrigin ?? '';

    // Parse and validate query params via Zod.
    const rawQuery = {
      installation_id: c.req.query('installation_id'),
      setup_action: c.req.query('setup_action'),
      state: c.req.query('state'),
    };

    const parsed = setupQuerySchema.safeParse(rawQuery);
    if (!parsed.success) {
      return c.redirect(`${dashboardOrigin}/integrations?error=validation_error`, 302);
    }

    const { installation_id, setup_action, state } = parsed.data;

    // Validate CSRF state from cookie.
    const cookieState = getCookie(c, STATE_COOKIE);
    if (!cookieState || cookieState.length === 0) {
      deleteCookie(c, STATE_COOKIE, { path: '/' });
      return c.redirect(`${dashboardOrigin}/integrations?error=missing_state_cookie`, 302);
    }

    const stateMatch = compareState(state, cookieState);
    if (!stateMatch) {
      deleteCookie(c, STATE_COOKIE, { path: '/' });
      return c.redirect(`${dashboardOrigin}/integrations?error=state_mismatch`, 302);
    }

    // setup_action=request: org admin approval is pending. No upsert —
    // the install event via the webhook (BE-3) will persist after approval.
    // Decision recorded per spec §22 open question (a).
    if (setup_action === 'request') {
      deleteCookie(c, STATE_COOKIE, { path: '/' });
      return c.redirect(`${dashboardOrigin}/integrations/github?error=pending_admin_approval`, 302);
    }

    // For install/update: installation_id is required.
    if (!installation_id) {
      deleteCookie(c, STATE_COOKIE, { path: '/' });
      return c.redirect(`${dashboardOrigin}/integrations?error=setup_failed`, 302);
    }

    const installationIdBigInt = BigInt(installation_id);

    try {
      // Enrich via App-level JWT — apps.getInstallation returns accountLogin,
      // accountType, and appId which are NOT NULL in the schema (spec §8.2.3).
      let accountLogin = '';
      let accountType = '';
      let appId = 0n;

      if (deps.github?.appAuthClient) {
        const fetchFn = deps.fetchInstallation ?? defaultFetchInstallation;
        const info = await fetchFn({
          installationId: installationIdBigInt,
          appAuthClient: deps.github.appAuthClient,
        });
        accountLogin = info.accountLogin;
        accountType = info.accountType;
        appId = info.appId;
      }

      // Upsert via withTenant so RLS tenant_isolation enforces isolation.
      // MUST use BigInt() so the GUC matches the installation_id column (spec §16.1).
      await withTenant(deps.db, installationIdBigInt, async (tx) => {
        await tx
          .insert(githubInstallations)
          .values({
            installationId: installationIdBigInt,
            accountLogin,
            accountType,
            appId,
            setupAction: setup_action,
            updatedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: githubInstallations.installationId,
            set: {
              accountLogin,
              accountType,
              appId,
              setupAction: setup_action,
              updatedAt: new Date(),
            },
          });
      });

      if (deps.auditAppender !== undefined) {
        try {
          await deps.auditAppender({
            event: 'github_installation.setup',
            installationId: installationIdBigInt,
            resourceType: 'github_installation',
            resourceId: String(installationIdBigInt),
            // actor is null: /github/setup uses CSRF-only auth, no JWT principal
          });
        } catch (err) {
          process.stderr.write(
            `[review-agent] WARN: audit write failed for github_installation.setup installationId=${installationIdBigInt}: ${String(err)}\n`,
          );
        }
      }
    } catch {
      deleteCookie(c, STATE_COOKIE, { path: '/' });
      return c.redirect(`${dashboardOrigin}/integrations?error=setup_failed`, 302);
    }

    deleteCookie(c, STATE_COOKIE, { path: '/' });
    return c.redirect(
      `${dashboardOrigin}/integrations/github/repos?installation_id=${installation_id}`,
      302,
    );
  });

  return app;
}
