/**
 * Role-based UI gating tests for ReposPage.
 * Tests that admin-only (delete, add repo) and editor (enable toggle) actions
 * are correctly shown/hidden based on the auth context role.
 */
import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AuthContextValue } from '../contexts/auth-context.js';
import { defaultTestAuthContext, renderWithProviders } from '../test/render.js';
import { ReposPage } from './repos.js';

const mockPatchMutate = vi.hoisted(() => vi.fn());
const mockDeleteMutate = vi.hoisted(() => vi.fn());

vi.mock('../api/client.js', () => ({
  useRepos: () => ({
    data: [
      {
        id: 'repo-001',
        platform: 'github',
        name: 'acme/api-service',
        enabled: true,
        lastReviewAt: null,
        lastOutcome: null,
      },
    ],
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  }),
  useIntegrations: () => ({
    data: {
      github: { configured: true, appId: 'app-1', appSlug: 'app', installationCount: 1 },
      codecommit: { configured: false, region: null },
      llm: { configured: false, provider: null, model: null },
    },
    isLoading: false,
    error: null,
  }),
  usePatchRepo: () => ({ mutate: mockPatchMutate, isPending: false }),
  useDeleteRepo: () => ({ mutate: mockDeleteMutate, isPending: false }),
  IS_MOCK: false,
}));

const viewerAuth: AuthContextValue = {
  ...defaultTestAuthContext,
  legacy: false,
  authenticated: true,
  principal: { id: '1', username: 'viewer-user' },
  memberships: [{ installationId: 'inst-1', role: 'viewer' }],
  hasRole: () => false,
  maxRole: 'viewer',
};

const editorAuth: AuthContextValue = {
  ...defaultTestAuthContext,
  legacy: false,
  authenticated: true,
  principal: { id: '2', username: 'editor-user' },
  memberships: [{ installationId: 'inst-1', role: 'editor' }],
  hasRole: (_, req) => req === 'viewer' || req === 'editor',
  maxRole: 'editor',
};

const adminAuth: AuthContextValue = {
  ...defaultTestAuthContext,
  legacy: false,
  authenticated: true,
  principal: { id: '3', username: 'admin-user' },
  memberships: [{ installationId: 'inst-1', role: 'admin' }],
  hasRole: () => true,
  maxRole: 'admin',
};

describe('ReposPage role-based UI gating', () => {
  it('admin sees [+ ADD REPO] link', () => {
    renderWithProviders(<ReposPage />, { route: '/repos', authContext: adminAuth });
    expect(screen.getByText(/add repo/i)).toBeInTheDocument();
  });

  it('viewer does NOT see [+ ADD REPO] link', () => {
    renderWithProviders(<ReposPage />, { route: '/repos', authContext: viewerAuth });
    expect(screen.queryByText(/add repo/i)).toBeNull();
  });

  it('editor does NOT see [+ ADD REPO] link', () => {
    renderWithProviders(<ReposPage />, { route: '/repos', authContext: editorAuth });
    expect(screen.queryByText(/add repo/i)).toBeNull();
  });

  it('admin sees the delete [DEL] button', () => {
    renderWithProviders(<ReposPage />, { route: '/repos', authContext: adminAuth });
    expect(screen.getByRole('button', { name: /delete acme\/api-service/i })).toBeInTheDocument();
  });

  it('viewer does NOT see the delete button', () => {
    renderWithProviders(<ReposPage />, { route: '/repos', authContext: viewerAuth });
    expect(screen.queryByRole('button', { name: /delete acme\/api-service/i })).toBeNull();
  });

  it('editor does NOT see the delete button', () => {
    renderWithProviders(<ReposPage />, { route: '/repos', authContext: editorAuth });
    expect(screen.queryByRole('button', { name: /delete acme\/api-service/i })).toBeNull();
  });

  it('viewer sees enabled toggle but it is disabled', () => {
    renderWithProviders(<ReposPage />, { route: '/repos', authContext: viewerAuth });
    const toggleBtn = screen.getByRole('button', { name: /disable acme\/api-service/i });
    expect(toggleBtn).toBeDisabled();
  });

  it('editor sees enabled toggle that is NOT disabled', () => {
    renderWithProviders(<ReposPage />, { route: '/repos', authContext: editorAuth });
    const toggleBtn = screen.getByRole('button', { name: /disable acme\/api-service/i });
    expect(toggleBtn).not.toBeDisabled();
  });

  it('admin sees enabled toggle that is NOT disabled', () => {
    renderWithProviders(<ReposPage />, { route: '/repos', authContext: adminAuth });
    const toggleBtn = screen.getByRole('button', { name: /disable acme\/api-service/i });
    expect(toggleBtn).not.toBeDisabled();
  });

  it('legacy mode: sees add repo link and delete button', () => {
    renderWithProviders(<ReposPage />, {
      route: '/repos',
      authContext: defaultTestAuthContext,
    });
    expect(screen.getByText(/add repo/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /delete acme\/api-service/i })).toBeInTheDocument();
  });
});
