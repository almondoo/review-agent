import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router-dom';
import './styles/global.css';
import './styles/typography.css';
import { router } from './app.js';
import i18n from './i18n/index.js';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 30_000,
    },
  },
});

// Set initial <html lang> from the resolved language.
document.documentElement.lang = i18n.language;

// Keep <html lang> in sync whenever language changes.
i18n.on('languageChanged', (lng: string) => {
  document.documentElement.lang = lng;
});

const rootEl = document.getElementById('root');
if (!rootEl) {
  throw new Error('Root element #root not found');
}

createRoot(rootEl).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
