import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import i18n from 'i18next';
import type { ReactElement } from 'react';
import { I18nextProvider } from 'react-i18next';
import { createMemoryRouter, MemoryRouter, RouterProvider } from 'react-router-dom';

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

type RenderOptions = {
  route?: string;
};

export function renderWithProviders(ui: ReactElement, { route = '/' }: RenderOptions = {}) {
  const queryClient = makeTestQueryClient();

  return render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[route]}>{ui}</MemoryRouter>
      </QueryClientProvider>
    </I18nextProvider>,
  );
}

type DataRouterRenderOptions = {
  initialEntries?: string[];
  routes?: Parameters<typeof createMemoryRouter>[0];
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
  { initialEntries = ['/'] }: Pick<DataRouterRenderOptions, 'initialEntries'> = {},
) {
  const queryClient = makeTestQueryClient();

  const router = createMemoryRouter(routes, { initialEntries });

  return render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </I18nextProvider>,
  );
}
