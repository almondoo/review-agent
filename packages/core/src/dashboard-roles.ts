import { z } from 'zod';

/**
 * Dashboard RBAC role constants (spec §18.x).
 *
 * Role hierarchy (inclusive): admin ⊇ editor ⊇ viewer
 * An `admin` satisfies any required role; a `viewer` only satisfies `viewer`.
 */
export const DASHBOARD_ROLES = ['viewer', 'editor', 'admin'] as const;

export type DashboardRole = (typeof DASHBOARD_ROLES)[number];

/** Numeric rank used by roleSatisfies. Higher = more privileged. */
const ROLE_RANK: Record<DashboardRole, number> = {
  viewer: 0,
  editor: 1,
  admin: 2,
};

/**
 * Returns true when `actual` has at least the privileges of `required`.
 *
 * Examples:
 *   roleSatisfies('admin',  'editor') → true
 *   roleSatisfies('editor', 'editor') → true
 *   roleSatisfies('viewer', 'editor') → false
 */
export function roleSatisfies(actual: DashboardRole, required: DashboardRole): boolean {
  return ROLE_RANK[actual] >= ROLE_RANK[required];
}

export const dashboardRoleSchema = z.enum(DASHBOARD_ROLES);
