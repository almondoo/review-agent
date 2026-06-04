import { describe, expect, it } from 'vitest';
import { DASHBOARD_ROLES, dashboardRoleSchema, roleSatisfies } from '../../dashboard-roles.js';

describe('DASHBOARD_ROLES', () => {
  it('contains exactly viewer, editor, admin in that order', () => {
    expect(DASHBOARD_ROLES).toEqual(['viewer', 'editor', 'admin']);
  });
});

describe('roleSatisfies', () => {
  // admin satisfies all roles
  it('admin satisfies admin', () => {
    expect(roleSatisfies('admin', 'admin')).toBe(true);
  });
  it('admin satisfies editor', () => {
    expect(roleSatisfies('admin', 'editor')).toBe(true);
  });
  it('admin satisfies viewer', () => {
    expect(roleSatisfies('admin', 'viewer')).toBe(true);
  });

  // editor satisfies editor and below, not admin
  it('editor does not satisfy admin', () => {
    expect(roleSatisfies('editor', 'admin')).toBe(false);
  });
  it('editor satisfies editor', () => {
    expect(roleSatisfies('editor', 'editor')).toBe(true);
  });
  it('editor satisfies viewer', () => {
    expect(roleSatisfies('editor', 'viewer')).toBe(true);
  });

  // viewer satisfies only viewer
  it('viewer does not satisfy admin', () => {
    expect(roleSatisfies('viewer', 'admin')).toBe(false);
  });
  it('viewer does not satisfy editor', () => {
    expect(roleSatisfies('viewer', 'editor')).toBe(false);
  });
  it('viewer satisfies viewer', () => {
    expect(roleSatisfies('viewer', 'viewer')).toBe(true);
  });
});

describe('dashboardRoleSchema', () => {
  it('parses valid role: viewer', () => {
    expect(dashboardRoleSchema.parse('viewer')).toBe('viewer');
  });
  it('parses valid role: editor', () => {
    expect(dashboardRoleSchema.parse('editor')).toBe('editor');
  });
  it('parses valid role: admin', () => {
    expect(dashboardRoleSchema.parse('admin')).toBe('admin');
  });
  it('rejects an invalid role', () => {
    expect(() => dashboardRoleSchema.parse('superuser')).toThrow();
  });
  it('rejects empty string', () => {
    expect(() => dashboardRoleSchema.parse('')).toThrow();
  });
});
