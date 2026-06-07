/**
 * Shared Hono context variable types for session authentication.
 *
 * Import `AuthEnv` when building Hono apps / routers that need to read
 * `c.get('principal')` or `c.get('role')`.
 */
import type { DashboardRole } from '@review-agent/core';

/** Principal stored in the Hono context after JWT authentication. */
export type ContextPrincipal = {
  readonly id: string;
  readonly username: string;
};

/**
 * Hono Env type that declares the typed context variables set by session
 * auth middleware and installation authz middleware.
 *
 * Use as a generic parameter: `new Hono<AuthEnv>()` or
 * `createMiddleware<AuthEnv>(...)`.
 */
export type AuthEnv = {
  Variables: {
    /**
     * Set by sessionAuth when a valid JWT is verified.
     * Absent (undefined) when the request authenticated via shared bearer token.
     */
    principal: ContextPrincipal | undefined;
    /**
     * Set by installationAuthz after role check succeeds.
     * Only present on routes protected by installationAuthz.
     */
    role: DashboardRole | undefined;
  };
};
