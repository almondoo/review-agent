import { Route, Routes } from 'react-router-dom';
import { Layout } from './components/layout.js';
import { HistoryPage } from './pages/history.js';
import { HistoryDetailPage } from './pages/history-detail.js';
import { IntegrationsPage } from './pages/integrations.js';
import { NotFoundPage } from './pages/not-found.js';
import { OverviewPage } from './pages/overview.js';
import { RepoDetailPage } from './pages/repo-detail.js';
import { RepoPromptPage } from './pages/repo-prompt.js';
import { ReposPage } from './pages/repos.js';
import { ReposNewPage } from './pages/repos-new.js';

export function App() {
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<OverviewPage />} />
        <Route path="/repos" element={<ReposPage />} />
        <Route path="/repos/new" element={<ReposNewPage />} />
        <Route path="/repos/:id" element={<RepoDetailPage />} />
        <Route path="/repos/:id/prompt" element={<RepoPromptPage />} />
        <Route path="/integrations" element={<IntegrationsPage />} />
        <Route path="/history" element={<HistoryPage />} />
        <Route path="/history/:id" element={<HistoryDetailPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </Layout>
  );
}
