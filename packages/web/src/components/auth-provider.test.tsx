/**
 * Tests for AuthProvider's OIDC callback handling (location.hash #token=...).
 *
 * The component also bootstraps auth state via useAuthMe — those paths are
 * exercised by the broader integration; here we focus on the hash-token branch.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from './auth-provider.js';

// --- Mocks ------------------------------------------------------------------

const mockNavigate = vi.hoisted(() => vi.fn());
const mockRegisterOnUnauthorized = vi.hoisted(() => vi.fn());
const mockUseAuthMe = vi.hoisted(() => vi.fn());
const mockApiLogout = vi.hoisted(() => vi.fn());
const mockSetSessionToken = vi.hoisted(() => vi.fn());

vi.mock('../api/client.js', () => ({
  IS_MOCK: false,
  registerOnUnauthorized: mockRegisterOnUnauthorized,
  useAuthMe: mockUseAuthMe,
  apiLogout: mockApiLogout,
}));

vi.mock('../lib/session-token.js', () => ({
  getSessionToken: () => null,
  setSessionToken: mockSetSessionToken,
  clearSessionToken: vi.fn(),
}));

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

// --- Helpers ----------------------------------------------------------------

function makeWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

function renderAuthProvider(initialEntry = '/') {
  const Wrapper = makeWrapper();
  const router = createMemoryRouter([{ path: '*', element: <AuthProvider /> }], {
    initialEntries: [initialEntry],
  });
  return render(
    <Wrapper>
      <RouterProvider router={router} />
    </Wrapper>,
  );
}

// Save / restore window.location around tests that modify it.
const originalLocation = window.location;

// --- Tests ------------------------------------------------------------------

describe('AuthProvider — OIDC callback hash handling', () => {
  beforeEach(() => {
    mockNavigate.mockReset();
    mockSetSessionToken.mockReset();
    mockRegisterOnUnauthorized.mockReset();
    // Default: /me returns unauthenticated (not the focus of these tests).
    mockUseAuthMe.mockReturnValue({ data: undefined, isError: false });
    // Reset location to clean state.
    Object.defineProperty(window, 'location', {
      writable: true,
      value: { ...originalLocation, hash: '', pathname: '/', search: '' },
    });
    // history.replaceState spy
    vi.spyOn(window.history, 'replaceState').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(window, 'location', { writable: true, value: originalLocation });
  });

  it('stores the token and strips the hash when #token=<jwt> is present', async () => {
    Object.defineProperty(window, 'location', {
      writable: true,
      value: { ...originalLocation, hash: '#token=jwt-from-oidc', pathname: '/', search: '' },
    });

    renderAuthProvider('/');

    await waitFor(() => {
      expect(mockSetSessionToken).toHaveBeenCalledWith('jwt-from-oidc');
    });
    expect(window.history.replaceState).toHaveBeenCalledWith(null, '', '/');
  });

  it('decodes URL-encoded token before storing', async () => {
    const token = 'a.b.c+special=chars';
    Object.defineProperty(window, 'location', {
      writable: true,
      value: {
        ...originalLocation,
        hash: `#token=${encodeURIComponent(token)}`,
        pathname: '/',
        search: '',
      },
    });

    renderAuthProvider('/');

    await waitFor(() => {
      expect(mockSetSessionToken).toHaveBeenCalledWith(token);
    });
  });

  it('does not call setSessionToken when hash is absent', async () => {
    Object.defineProperty(window, 'location', {
      writable: true,
      value: { ...originalLocation, hash: '', pathname: '/', search: '' },
    });

    renderAuthProvider('/');

    // Give effects a chance to run.
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(mockSetSessionToken).not.toHaveBeenCalled();
  });

  it('does not call setSessionToken when hash does not start with #token=', async () => {
    Object.defineProperty(window, 'location', {
      writable: true,
      value: { ...originalLocation, hash: '#section-anchor', pathname: '/', search: '' },
    });

    renderAuthProvider('/');

    await new Promise<void>((r) => setTimeout(r, 0));
    expect(mockSetSessionToken).not.toHaveBeenCalled();
  });

  it('preserves pathname and search when stripping hash', async () => {
    Object.defineProperty(window, 'location', {
      writable: true,
      value: {
        ...originalLocation,
        hash: '#token=my-jwt',
        pathname: '/some/path',
        search: '?foo=bar',
      },
    });

    renderAuthProvider('/');

    await waitFor(() => {
      expect(window.history.replaceState).toHaveBeenCalledWith(null, '', '/some/path?foo=bar');
    });
  });
});
