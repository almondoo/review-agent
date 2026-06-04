import { describe, expect, it } from 'vitest';
import type { Membership } from '../api/types.js';
import { computeMaxRole, hasRoleForInstallation } from './auth-context.js';

describe('computeMaxRole', () => {
  it('returns undefined for empty memberships', () => {
    expect(computeMaxRole([])).toBeUndefined();
  });

  it('returns the single role when only one membership exists', () => {
    const memberships: Membership[] = [{ installationId: '1', role: 'editor' }];
    expect(computeMaxRole(memberships)).toBe('editor');
  });

  it('returns admin when at least one membership is admin', () => {
    const memberships: Membership[] = [
      { installationId: '1', role: 'viewer' },
      { installationId: '2', role: 'admin' },
      { installationId: '3', role: 'editor' },
    ];
    expect(computeMaxRole(memberships)).toBe('admin');
  });

  it('returns editor when memberships are viewer and editor', () => {
    const memberships: Membership[] = [
      { installationId: '1', role: 'viewer' },
      { installationId: '2', role: 'editor' },
    ];
    expect(computeMaxRole(memberships)).toBe('editor');
  });

  it('returns viewer when all memberships are viewer', () => {
    const memberships: Membership[] = [
      { installationId: '1', role: 'viewer' },
      { installationId: '2', role: 'viewer' },
    ];
    expect(computeMaxRole(memberships)).toBe('viewer');
  });
});

describe('hasRoleForInstallation', () => {
  const memberships: Membership[] = [
    { installationId: 'inst-1', role: 'viewer' },
    { installationId: 'inst-2', role: 'editor' },
    { installationId: 'inst-3', role: 'admin' },
  ];

  it('returns false when installation is not found', () => {
    expect(hasRoleForInstallation(memberships, 'inst-999', 'viewer')).toBe(false);
  });

  it('viewer satisfies viewer requirement', () => {
    expect(hasRoleForInstallation(memberships, 'inst-1', 'viewer')).toBe(true);
  });

  it('viewer does NOT satisfy editor requirement', () => {
    expect(hasRoleForInstallation(memberships, 'inst-1', 'editor')).toBe(false);
  });

  it('viewer does NOT satisfy admin requirement', () => {
    expect(hasRoleForInstallation(memberships, 'inst-1', 'admin')).toBe(false);
  });

  it('editor satisfies viewer requirement (upward compat)', () => {
    expect(hasRoleForInstallation(memberships, 'inst-2', 'viewer')).toBe(true);
  });

  it('editor satisfies editor requirement', () => {
    expect(hasRoleForInstallation(memberships, 'inst-2', 'editor')).toBe(true);
  });

  it('editor does NOT satisfy admin requirement', () => {
    expect(hasRoleForInstallation(memberships, 'inst-2', 'admin')).toBe(false);
  });

  it('admin satisfies admin requirement', () => {
    expect(hasRoleForInstallation(memberships, 'inst-3', 'admin')).toBe(true);
  });

  it('admin satisfies editor requirement', () => {
    expect(hasRoleForInstallation(memberships, 'inst-3', 'editor')).toBe(true);
  });

  it('admin satisfies viewer requirement', () => {
    expect(hasRoleForInstallation(memberships, 'inst-3', 'viewer')).toBe(true);
  });
});
