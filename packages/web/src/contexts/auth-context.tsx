import { createContext, useContext } from 'react';
import type { AuthPrincipal, Membership, Role } from '../api/types.js';

const ROLE_RANK: Record<Role, number> = { viewer: 1, editor: 2, admin: 3 };

export type AuthContextValue = {
  /** True when operating in legacy (shared-token) mode — all operations permitted. */
  legacy: boolean;
  /** True when a session JWT is authenticated (i.e. not legacy, not unauthenticated). */
  authenticated: boolean;
  /** Session principal (undefined in legacy mode or when unauthenticated). */
  principal: AuthPrincipal | undefined;
  /** Per-installation memberships (empty in legacy mode). */
  memberships: Membership[];
  /**
   * Returns true if the user has at least the required role for the given installation.
   * Admin implies editor implies viewer.
   * In legacy mode always returns true.
   */
  hasRole: (installationId: string, required: Role) => boolean;
  /**
   * The highest role across all memberships, or 'admin' in legacy mode.
   * Useful for global nav UI gating.
   */
  maxRole: Role | undefined;
  /** Clear token and navigate away. */
  logout: () => Promise<void>;
};

export const AuthContext = createContext<AuthContextValue>({
  legacy: false,
  authenticated: false,
  principal: undefined,
  memberships: [],
  hasRole: () => false,
  maxRole: undefined,
  logout: async () => {},
});

export function useAuth(): AuthContextValue {
  return useContext(AuthContext);
}

export function computeMaxRole(memberships: Membership[]): Role | undefined {
  if (memberships.length === 0) return undefined;
  return memberships.reduce<Role>((best, m) => {
    return ROLE_RANK[m.role] > ROLE_RANK[best] ? m.role : best;
  }, 'viewer');
}

export function hasRoleForInstallation(
  memberships: Membership[],
  installationId: string,
  required: Role,
): boolean {
  const membership = memberships.find((m) => m.installationId === installationId);
  if (!membership) return false;
  return ROLE_RANK[membership.role] >= ROLE_RANK[required];
}
