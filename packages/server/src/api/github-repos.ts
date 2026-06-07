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
 * Authz (issue #161 §F):
 *   GET  /github/installations/:id/repos  — viewer + membership
 *   POST /repos/bulk                      — admin  + membership
 *
 * When no JWT principal is present (legacy / shared-token), the original
 * multiTenantGuard behaviour is preserved: multiTenant=true → 501,
 * multiTenant=false → pass-through (single-operator implicit trust).
 */
import { githubInstallations, repos } from '@review-agent/core/db';
import type { AuditAppender, DbClient } from '@review-agent/db';
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
import type { AuthEnv } from '../auth/types.js';
import { installationAuthz } from './middleware/installation-authz.js';

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
   * Fail-closed multi-tenant guard flag. When true both routes return 501
   * (principal absent path) before any token mint or DB write.
   * See docs/security/multi-tenant-authz.md.
   */
  readonly multiTenant?: boolean;
  readonly auditAppender?: AuditAppender;
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
  const app = new Hono<AuthEnv>();
  const generateId = deps.generateId ?? defaultId;
  const multiTenant = deps.multiTenant ?? false;

  // ------------------------------------------------------------------
  // GET /github/installations/:installationId/repos
  //
  // Role required: viewer + membership check on installationId path param.
  // Legacy/shared-token path: multiTenant gate (501 or pass-through).
  //
  // Generates an installation token, calls listInstallationRepos,
  // joins against the local repos table to compute `registered`.
  //
  // Returns 404 when the installation does not exist or is suspended.
  // Returns 503 when the appAuth client is not configured.
  // ------------------------------------------------------------------
  app.get(
    '/github/installations/:installationId/repos',
    installationAuthz({
      required: 'viewer',
      getInstallationId: (c) => c.req.param('installationId'),
      multiTenant,
      db: deps.db,
    }),
    async (c) => {
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

      let githubRepos: InstallationRepo[];
      try {
        const { token } = await deps.appAuth.appAuthClient.getInstallationToken(installationId);

        /* v8 ignore start */
        const { Octokit } = await import('@octokit/rest');
        const octokit = new Octokit({ auth: token });
        /* v8 ignore stop */

        githubRepos = await listInstallationRepos(octokit, installationId);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return c.json({ error: 'github_api_error', message }, 502);
      }

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
    },
  );

  // ------------------------------------------------------------------
  // POST /repos/bulk
  //
  // Role required: admin + membership check on installationId in body.
  // Legacy/shared-token path: multiTenant gate (501 or pass-through).
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
  app.post(
    '/repos/bulk',
    installationAuthz({
      required: 'admin',
      getInstallationId: async (c) => {
        try {
          const body = await c.req.json();
          const id = (body as Record<string, unknown>)?.installationId;
          return typeof id === 'number' && Number.isInteger(id) && id > 0 ? String(id) : undefined;
        } catch {
          return undefined;
        }
      },
      multiTenant,
      db: deps.db,
    }),
    async (c) => {
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

      if (deps.auditAppender !== undefined && created.length > 0) {
        const actor = c.get('principal')?.id ?? null;
        try {
          await deps.auditAppender({
            event: 'repo.bulk_register',
            installationId,
            resourceType: 'repo',
            resourceId: String(installationId),
            ...(actor !== null ? { actor } : {}),
          });
        } catch (err) {
          process.stderr.write(
            `[review-agent] WARN: audit write failed for repo.bulk_register installationId=${installationId}: ${String(err)}\n`,
          );
        }
      }

      if (errors.length === 0 && alreadyExists.length === 0 && created.length > 0) {
        return c.json(result, 201);
      }

      if (errors.length === 0 && created.length === 0) {
        return c.json(result, 200);
      }

      return c.json(result, 207);
    },
  );

  return app as unknown as Hono;
}
