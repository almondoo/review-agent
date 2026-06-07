import { useCallback, useEffect, useMemo } from 'react';
import { Outlet, useNavigate } from 'react-router-dom';
import { apiLogout, IS_MOCK, registerOnUnauthorized, useAuthMe } from '../api/client.js';
import type { Membership, Role } from '../api/types.js';
import { AuthContext, computeMaxRole, hasRoleForInstallation } from '../contexts/auth-context.js';
import { setSessionToken } from '../lib/session-token.js';

/**
 * AuthProvider is a router layout element that bootstraps auth state by
 * calling /api/auth/me on mount, then provides the result via AuthContext.
 *
 * - VITE_USE_MOCK=true  → bypass auth entirely (admin/authenticated).
 * - legacy response     → legacy mode, all operations permitted.
 * - session response    → principal + memberships stored in context.
 * - 401 from /me        → apiFetch fires onUnauthorized → redirect /login.
 *
 * OIDC callback handling:
 * - On mount, checks location.hash for `#token=<jwt>` written by the server
 *   after a successful OIDC flow (GET /api/auth/oidc/callback → 302 to
 *   <dashboardOrigin>/#token=<urlencoded session JWT>).
 * - If found: stores the token via setSessionToken, removes the hash from
 *   browser history (token must not persist in the URL or history), then
 *   lets useAuthMe proceed normally — identical to the password login path.
 */
export function AuthProvider() {
  const navigate = useNavigate();

  // Register the 401 callback so apiFetch can trigger logout-redirect.
  useEffect(() => {
    registerOnUnauthorized(() => {
      void navigate('/login', { replace: true });
    });
  }, [navigate]);

  // OIDC callback: consume #token=<jwt> from the hash, store it, strip hash.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const hash = window.location.hash;
    if (!hash.startsWith('#token=')) return;
    const raw = hash.slice('#token='.length);
    const token = decodeURIComponent(raw);
    if (token) {
      setSessionToken(token);
    }
    // Remove the fragment from URL and history so the token is not visible
    // after navigation or in the browser history stack.
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
    // useAuthMe will now pick up the freshly stored token on its next fetch.
  }, []);

  const { data, isError } = useAuthMe();

  const logout = useCallback(async () => {
    await apiLogout();
    void navigate('/login', { replace: true });
  }, [navigate]);

  const value = useMemo(() => {
    // Mock mode: behave as admin, skip /me entirely.
    if (IS_MOCK) {
      const mockMemberships: Membership[] = [];
      return {
        legacy: true,
        authenticated: true,
        principal: undefined,
        memberships: mockMemberships,
        hasRole: (_installationId: string, _required: Role) => true,
        maxRole: 'admin' as Role,
        logout,
      };
    }

    if (!data) {
      // Loading or error — default to unauthenticated.
      return {
        legacy: false,
        authenticated: false,
        principal: undefined,
        memberships: [] as Membership[],
        hasRole: (_installationId: string, _required: Role) => false,
        maxRole: undefined,
        logout,
      };
    }

    if (data.legacy) {
      return {
        legacy: true,
        authenticated: true,
        principal: undefined,
        memberships: [] as Membership[],
        hasRole: (_installationId: string, _required: Role) => true,
        maxRole: 'admin' as Role,
        logout,
      };
    }

    // Session mode.
    const { principal, memberships } = data;
    return {
      legacy: false,
      authenticated: true,
      principal,
      memberships,
      hasRole: (installationId: string, required: Role) =>
        hasRoleForInstallation(memberships, installationId, required),
      maxRole: computeMaxRole(memberships),
      logout,
    };
  }, [data, logout]);

  // If /me returned a non-401 error in non-mock mode, redirect to /login.
  useEffect(() => {
    if (!IS_MOCK && isError) {
      void navigate('/login', { replace: true });
    }
  }, [isError, navigate]);

  return (
    <AuthContext.Provider value={value}>
      <Outlet />
    </AuthContext.Provider>
  );
}
