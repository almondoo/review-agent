import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import i18n from 'i18next';
import type { ReactElement } from 'react';
import { I18nextProvider } from 'react-i18next';
import { createMemoryRouter, MemoryRouter, RouterProvider } from 'react-router-dom';
import type { AuthContextValue } from '../contexts/auth-context.js';
import { AuthContext } from '../contexts/auth-context.js';

function makeTestQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        gcTime: 0,
      },
    },
  });
}

/**
 * Default auth context for tests: legacy mode (all permissions, no login required).
 * Tests that need to verify role-gating should pass a custom authContext value.
 */
const defaultTestAuthContext: AuthContextValue = {
  legacy: true,
  authenticated: true,
  principal: undefined,
  memberships: [],
  hasRole: () => true,
  maxRole: 'admin',
  logout: async () => {},
};

type RenderOptions = {
  route?: string;
  authContext?: AuthContextValue;
};

export function renderWithProviders(
  ui: ReactElement,
  { route = '/', authContext = defaultTestAuthContext }: RenderOptions = {},
) {
  const queryClient = makeTestQueryClient();

  return render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={queryClient}>
        <AuthContext.Provider value={authContext}>
          <MemoryRouter initialEntries={[route]}>{ui}</MemoryRouter>
        </AuthContext.Provider>
      </QueryClientProvider>
    </I18nextProvider>,
  );
}

type DataRouterRenderOptions = {
  initialEntries?: string[];
  routes?: Parameters<typeof createMemoryRouter>[0];
  authContext?: AuthContextValue;
};

/**
 * Render helper for pages that use `useBlocker` (or other data-router-only
 * hooks). Uses `createMemoryRouter` + `RouterProvider` instead of the legacy
 * `MemoryRouter` wrapper.
 *
 * Pass `routes` to define the full route tree.  The simplest usage is to
 * provide a single-element array with the component under test:
 *
 *   renderWithDataRouter([{ path: '/repos/:id/prompt', element: <RepoPromptPage /> }], {
 *     initialEntries: ['/repos/repo-001/prompt'],
 *   });
 */
export function renderWithDataRouter(
  routes: Parameters<typeof createMemoryRouter>[0],
  {
    initialEntries = ['/'],
    authContext = defaultTestAuthContext,
  }: Pick<DataRouterRenderOptions, 'initialEntries' | 'authContext'> = {},
) {
  const queryClient = makeTestQueryClient();

  const router = createMemoryRouter(routes, { initialEntries });

  return render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={queryClient}>
        <AuthContext.Provider value={authContext}>
          <RouterProvider router={router} />
        </AuthContext.Provider>
      </QueryClientProvider>
    </I18nextProvider>,
  );
}

export { defaultTestAuthContext };
