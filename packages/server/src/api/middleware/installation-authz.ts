/**
 * Installation authorization middleware.
 *
 * Replaces `multiTenantGuard` for per-user JWT sessions while preserving
 * exact backward compatibility for legacy/shared-token deployments.
 *
 * Behaviour matrix:
 *   - principal present (JWT auth):
 *       1. Resolve installationId via getInstallationId(c) → 400 if missing.
 *       2. getMembership(db, principal.id, installationId) → 404 if no membership
 *          (404 is used intentionally for enumeration resistance — the caller
 *          cannot distinguish "installation does not exist" from "no access").
 *       3. roleSatisfies(membership.role, required) → 403 if insufficient.
 *       4. c.set('role', membership.role) and call next().
 *
 *   - principal absent (legacy / both + shared token):
 *       - multiTenant=true  → 501 (issue #132 interim guard preserved).
 *       - multiTenant=false → next() (single-operator unchanged behaviour).
 *
 * The `multi-tenant-guard.ts` file is preserved as a thin re-export for
 * backward compat. All new code should use installationAuthz.
 *
 * See docs/security/multi-tenant-authz.md and issue #132.
 */
import type { DashboardRole } from '@review-agent/core';
import { roleSatisfies } from '@review-agent/core';
import type { DbClient } from '@review-agent/db';
import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import { getMembership } from '../../auth/principal-store.js';
import type { AuthEnv } from '../../auth/types.js';

export type InstallationAuthzOptions = {
  /** Minimum required role for this endpoint. */
  readonly required: DashboardRole;
  /**
   * Extracts the installationId string from the request context.
   * Return undefined if the id cannot be resolved (→ 400).
   * May be async (e.g. when reading from the request body).
   */
  readonly getInstallationId: (c: Context) => string | undefined | Promise<string | undefined>;
  /**
   * Fail-closed multi-tenant guard for legacy/shared-token deployments.
   * When true and principal is absent → 501.
   * When false and principal is absent → next() (single-operator).
   */
  readonly multiTenant: boolean;
  /** DB client used for membership lookups. */
  readonly db: DbClient;
};

/**
 * Factory that returns an installation authorization middleware.
 */
export function installationAuthz(opts: InstallationAuthzOptions) {
  return createMiddleware<AuthEnv>(async (c, next) => {
    const principal = c.get('principal');

    if (principal !== undefined) {
      // --- Per-user JWT auth path ---
      const installationId = await opts.getInstallationId(c);
      if (installationId === undefined) {
        return c.json({ error: 'installationId required' }, 400);
      }

      const membership = await getMembership(opts.db, principal.id, installationId);
      if (membership === null) {
        // 404 for enumeration resistance: attacker cannot distinguish "no such
        // installation" from "you have no membership in that installation".
        return c.json({ error: 'not_found' }, 404);
      }

      if (!roleSatisfies(membership.role, opts.required)) {
        return c.json({ error: 'forbidden' }, 403);
      }

      c.set('role', membership.role);
      await next();
      return;
    }

    // --- Legacy / shared-token path ---
    if (opts.multiTenant) {
      return c.json(
        {
          error:
            'per_installation_authz_not_implemented: these endpoints are disabled in multi-tenant mode until per-installation authorization lands (issue #132)',
        },
        501,
      );
    }

    await next();
  });
}

export type RequireRoleOptions = {
  /** Minimum required role. */
  readonly required: DashboardRole;
};

/**
 * Thin role-only guard for endpoints where installationId cannot be extracted
 * from the request (e.g. per-repo routes that only have a repo UUID).
 *
 * Behaviour:
 *   - principal present: check roleSatisfies(role, required) using the role
 *     already stored in context by a preceding installationAuthz call. If no
 *     role is set yet (route does not use installationAuthz), require at least
 *     `required` by falling back to a conservative deny — this keeps the guard
 *     fail-closed even when installationAuthz is not composed.
 *   - principal absent (legacy / shared-token): always next() — legacy
 *     deployments are single-operator and have implicit full trust.
 *
 * NOTE: this middleware does NOT perform membership lookup. It relies on
 * installationAuthz having run first and set c.get('role'), OR treats any
 * authenticated principal without a resolved role as insufficiently privileged
 * for roles above 'viewer'.
 */
export function requireRole(opts: RequireRoleOptions) {
  return createMiddleware<AuthEnv>(async (c, next) => {
    const principal = c.get('principal');

    if (principal !== undefined) {
      const role = c.get('role');
      // If installationAuthz already ran and set a role, use it.
      // Otherwise deny: we cannot verify the role without a membership lookup.
      if (role === undefined) {
        return c.json({ error: 'forbidden' }, 403);
      }
      if (!roleSatisfies(role, opts.required)) {
        return c.json({ error: 'forbidden' }, 403);
      }
    }

    // Legacy / shared-token path: pass through (single-operator implicit trust).
    await next();
  });
}
