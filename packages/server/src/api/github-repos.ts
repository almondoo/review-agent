/**
 * GET /api/github/installations/:installationId/repos
 *   – Fetches the full list of repos accessible to a GitHub App installation,
 *     joined against the local `repos` table to flag `registered`.
 *
 * POST /api/repos/bulk
 *   – Bulk-registers repo names from a GitHub App installation.
 *
 * Spec §8.2.4 (accessible repos API), §8.2.5 (bulk repo registration),
 * §16.1 (RLS, withTenant for INSERT).
 *
 * NOTE (spec §8.2.4 open question b / issue #132):
 *   Per-installation authorization gap: in the current single-tenant model,
 *   any authenticated dashboard user can enumerate repos for an arbitrary
 *   installationId. Accepted as a known gap for single-operator deployments.
 *   A fail-closed `REVIEW_AGENT_MULTI_TENANT` interlock now guards these
 *   endpoints: when set to true they return 501 before any token mint or DB
 *   write, making it structurally impossible to ship the IDOR in multi-tenant
 *   mode until per-installation authz lands. See
 *   docs/security/multi-tenant-authz.md and issue #132.
 */
import { githubInstallations, repos } from '@review-agent/core/db';
import type { DbClient } from '@review-agent/db';
import { withTenant } from '@review-agent/db';
import type {
  AppAuthClient,
  AppOctokitFactory,
  InstallationRepo,
} from '@review-agent/platform-github';
import { listInstallationRepos } from '@review-agent/platform-github';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { multiTenantGuard } from './middleware/multi-tenant-guard.js';

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

export type AppAuthDeps = {
  /**
   * App-level auth client providing `getInstallationToken` and `createAppJwt`.
   * Required for GET /api/github/installations/:installationId/repos.
   */
  readonly appAuthClient: AppAuthClient;
  /**
   * Factory that builds an installation-scoped Octokit.
   * If absent, falls back to calling listInstallationRepos directly
   * with a freshly-minted token.
   */
  readonly octokitFactory?: AppOctokitFactory;
};

export type GithubReposDeps = {
  readonly db: DbClient;
  readonly now?: () => Date;
  readonly generateId?: () => string;
  /**
   * When present, the accessible-repos and bulk-register endpoints are available.
   * When absent, GET /api/github/installations/:installationId/repos returns 503.
   */
  readonly appAuth?: AppAuthDeps;
  /**
   * Fail-closed multi-tenant guard flag. When true both routes return 501 before
   * any token mint or DB write. See docs/security/multi-tenant-authz.md.
   */
  readonly multiTenant?: boolean;
};

// ---------------------------------------------------------------------------
// Request / response Zod schemas
// ---------------------------------------------------------------------------

const installationIdParamSchema = z.object({
  installationId: z
    .string()
    .regex(/^\d+$/, 'installationId must be a numeric string')
    .transform((v) => BigInt(v)),
});

const bulkRepoBodySchema = z.object({
  installationId: z
    .number()
    .int()
    .positive('installationId must be a positive integer')
    .transform((v) => BigInt(v)),
  names: z.array(z.string().min(1).max(200)).min(1).max(100, 'names may contain at most 100 items'),
});

// ---------------------------------------------------------------------------
// Response types (publicly visible — mirrors frontend API surface)
// ---------------------------------------------------------------------------

export type InstallationRepoItem = {
  id: number;
  fullName: string;
  private: boolean;
  registered: boolean;
};

export type AccessibleReposResponse = {
  repos: InstallationRepoItem[];
};

export type BulkRepoResult = {
  created: string[];
  alreadyExists: string[];
  errors: { name: string; message: string }[];
};

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

function defaultId(): string {
  return crypto.randomUUID();
}

export function createGithubReposRouter(deps: GithubReposDeps): Hono {
  const app = new Hono();
  const generateId = deps.generateId ?? defaultId;

  // Fail-closed guard: when REVIEW_AGENT_MULTI_TENANT=true both routes
  // return 501 before any token mint or DB write (issue #132).
  app.use('*', multiTenantGuard({ multiTenant: deps.multiTenant ?? false }));

  // ------------------------------------------------------------------
  // GET /github/installations/:installationId/repos
  //
  // Generates an installation token, calls listInstallationRepos,
  // joins against the local repos table to compute `registered`.
  //
  // Returns 404 when the installation does not exist or is suspended.
  // Returns 503 when the appAuth client is not configured.
  // ------------------------------------------------------------------
  app.get('/github/installations/:installationId/repos', async (c) => {
    if (deps.appAuth === undefined) {
      return c.json({ error: 'github_app_not_configured' }, 503);
    }

    const rawParam = { installationId: c.req.param('installationId') };
    const parsed = installationIdParamSchema.safeParse(rawParam);
    if (!parsed.success) {
      return c.json({ error: 'validation_error', issues: parsed.error.issues }, 422);
    }

    const { installationId } = parsed.data;

    // Verify installation exists and is not suspended.
    // RLS: github_installations is tenant-scoped. To read a specific
    // installation row without a withTenant context, use a raw select
    // against the non-RLS admin path, OR check the row via withTenant.
    // In the single-tenant model the row IS accessible via withTenant
    // for the given installationId.
    const installationRows = await (async () => {
      try {
        return await withTenant(deps.db, installationId, async (tx) =>
          tx
            .select({
              installationId: githubInstallations.installationId,
              suspendedAt: githubInstallations.suspendedAt,
            })
            .from(githubInstallations)
            .where(eq(githubInstallations.installationId, installationId))
            .limit(1),
        );
      } catch {
        return [];
      }
    })();

    const installation = installationRows[0];
    if (installation === undefined || installation.suspendedAt !== null) {
      return c.json({ error: 'not_found' }, 404);
    }

    // Fetch the full set of repos accessible to this installation via the
    // GitHub Apps API. We mint a fresh installation token and use a simple
    // Octokit instance (avoids needing the full AppOctokitFactory for this
    // read-only listing).
    let githubRepos: InstallationRepo[];
    try {
      // Obtain a fresh installation token.
      const { token } = await deps.appAuth.appAuthClient.getInstallationToken(installationId);

      // Dynamically import Octokit so this file doesn't hard-bind to
      // @octokit/rest at module load time (same pattern as github-setup.ts).
      /* v8 ignore start */
      const { Octokit } = await import('@octokit/rest');
      const octokit = new Octokit({ auth: token });
      /* v8 ignore stop */

      githubRepos = await listInstallationRepos(octokit, installationId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: 'github_api_error', message }, 502);
    }

    // Join against the local repos table to flag which are already registered.
    // Query by full_name, limited to repos whose installation_id matches or
    // whose name is in the set (covers manually-registered repos too).
    const fullNames = githubRepos.map((r) => r.fullName);
    const registeredNames = new Set<string>();

    if (fullNames.length > 0) {
      const registeredRows = await deps.db
        .select({ name: repos.name })
        .from(repos)
        .where(and(inArray(repos.name, fullNames), isNull(repos.deletedAt)));

      for (const row of registeredRows) {
        registeredNames.add(row.name);
      }
    }

    const repoItems: InstallationRepoItem[] = githubRepos.map((r) => ({
      id: r.id,
      fullName: r.fullName,
      private: r.private,
      registered: registeredNames.has(r.fullName),
    }));

    const response: AccessibleReposResponse = { repos: repoItems };
    return c.json(response, 200);
  });

  // ------------------------------------------------------------------
  // POST /repos/bulk
  //
  // Accepts { installationId: number, names: string[] }.
  // For each name:
  //   - if already present in repos (non-deleted) → alreadyExists
  //   - otherwise INSERT via withTenant RLS transaction → created
  //   - failures → errors
  //
  // Response codes:
  //   201 — all newly created
  //   200 — all alreadyExists (nothing new)
  //   207 — mixed or any errors
  // ------------------------------------------------------------------
  app.post('/repos/bulk', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }

    const parsed = bulkRepoBodySchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'validation_error', issues: parsed.error.issues }, 422);
    }

    const { installationId, names } = parsed.data;
    const now = (deps.now ?? (() => new Date()))();

    // Find which names already exist (non-soft-deleted).
    const existingRows = await deps.db
      .select({ name: repos.name })
      .from(repos)
      .where(and(inArray(repos.name, names), isNull(repos.deletedAt)));

    const existingNames = new Set(existingRows.map((r) => r.name));

    const created: string[] = [];
    const alreadyExists: string[] = [];
    const errors: { name: string; message: string }[] = [];

    for (const name of names) {
      if (existingNames.has(name)) {
        alreadyExists.push(name);
        continue;
      }

      // INSERT via withTenant so RLS enforces tenant isolation.
      try {
        const id = generateId();
        await withTenant(deps.db, installationId, async (tx) => {
          await tx.insert(repos).values({
            id,
            platform: 'github' as const,
            name,
            enabled: true,
            installationId,
            createdAt: now,
            updatedAt: now,
          });
        });
        created.push(name);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        errors.push({ name, message });
      }
    }

    const result: BulkRepoResult = { created, alreadyExists, errors };

    // 201: all newly created (no errors, no alreadyExists)
    if (errors.length === 0 && alreadyExists.length === 0 && created.length > 0) {
      return c.json(result, 201);
    }

    // 200: all alreadyExists (no new rows, no errors)
    if (errors.length === 0 && created.length === 0) {
      return c.json(result, 200);
    }

    // 207: mixed (some created, some alreadyExists, or any errors)
    return c.json(result, 207);
  });

  return app;
}
