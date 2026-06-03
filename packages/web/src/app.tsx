import { createBrowserRouter } from 'react-router-dom';
import { Layout } from './components/layout.js';
import { ByokKeysPage } from './pages/byok-keys.js';
import { HistoryPage } from './pages/history.js';
import { HistoryDetailPage } from './pages/history-detail.js';
import { HowItWorksPage } from './pages/how-it-works.js';
import { IntegrationsPage } from './pages/integrations.js';
import { NotFoundPage } from './pages/not-found.js';
import { OverviewPage } from './pages/overview.js';
import { RepoDetailPage } from './pages/repo-detail.js';
import { RepoPromptPage } from './pages/repo-prompt.js';
import { ReposPage } from './pages/repos.js';
import { ReposNewPage } from './pages/repos-new.js';

export const router = createBrowserRouter([
  {
    element: <Layout />,
    children: [
      { path: '/', element: <OverviewPage /> },
      { path: '/repos', element: <ReposPage /> },
      { path: '/repos/new', element: <ReposNewPage /> },
      { path: '/repos/:id', element: <RepoDetailPage /> },
      { path: '/repos/:id/prompt', element: <RepoPromptPage /> },
      { path: '/integrations', element: <IntegrationsPage /> },
      { path: '/integrations/keys', element: <ByokKeysPage /> },
      { path: '/history', element: <HistoryPage /> },
      { path: '/history/:id', element: <HistoryDetailPage /> },
      { path: '/how-it-works', element: <HowItWorksPage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]);
