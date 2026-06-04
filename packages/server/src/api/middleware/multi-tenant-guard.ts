import type { MiddlewareHandler } from 'hono';

export type MultiTenantGuardOptions = {
  /**
   * When true the six installationId-input endpoints are disabled (501) until
   * per-installation authz lands (issue #132 GA design).
   * When false (default, single-operator mode) the guard is a no-op.
   */
  multiTenant: boolean;
};

/**
 * Fail-closed multi-tenant guard for `/api` routes that accept an
 * arbitrary `installationId` from request input.
 *
 * Behaviour:
 *   multiTenant=false (default) → call next(); single-operator behaviour
 *                                 unchanged.
 *   multiTenant=true            → immediately return 501 Not Implemented
 *                                 before any getInstallationToken call or DB
 *                                 write. This makes shipping the IDOR by
 *                                 accident structurally impossible when
 *                                 flipping to multi-tenant mode.
 *
 * 501 is intentional (not 403/404): the endpoint is implemented but
 * multi-tenant *authorization* is not yet available. 403/404 is reserved
 * for the real per-caller denial at GA (see docs/security/multi-tenant-authz.md).
 *
 * Error envelope matches the existing server shape: { error: string }.
 *
 * See docs/security/multi-tenant-authz.md and issue #132.
 */
export function multiTenantGuard(opts: MultiTenantGuardOptions): MiddlewareHandler {
  return async (c, next) => {
    if (!opts.multiTenant) {
      await next();
      return;
    }
    return c.json(
      {
        error:
          'per_installation_authz_not_implemented: these endpoints are disabled in multi-tenant mode until per-installation authorization lands (issue #132)',
      },
      501,
    );
  };
}
