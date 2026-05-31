import { screen } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RepoDetail, RepoMetrics, RepoPrompt } from '../api/types.js';
import { renderWithProviders } from '../test/render.js';
import { RepoDetailPage } from './repo-detail.js';

const SAMPLE_SYSTEM_PROMPT =
  'You are an expert software engineer performing a thorough code review. Your goal is to identify bugs, security vulnerabilities, performance issues, and maintainability concerns.';

const mockRepoDetail: RepoDetail = {
  id: 'repo-001',
  platform: 'github',
  name: 'acme/api-service',
  enabled: true,
  lastReviewAt: '2026-05-28T09:14:00Z',
  lastOutcome: 'changes_requested',
  createdAt: '2026-01-15T08:00:00Z',
  updatedAt: '2026-05-28T09:00:00Z',
  systemPromptPresent: true,
};

const mockMetrics: RepoMetrics = {
  totalReviews: 8,
  reviewsLast30d: 5,
  avgDurationMs: 6500,
  totalCostUsd: 0.245,
};

const mockPrompt: RepoPrompt = {
  systemPrompt: SAMPLE_SYSTEM_PROMPT,
  updatedAt: '2026-05-20T10:00:00Z',
};

vi.mock('../api/client.js', () => ({
  useRepoDetail: (_id: string) => ({ data: mockRepoDetail, isLoading: false, error: null }),
  useRepoMetrics: (_id: string) => ({ data: mockMetrics }),
  useRepoReviews: (_id: string, _limit: number) => ({ data: { items: [], nextCursor: null } }),
  useRepoPrompt: (_id: string) => ({ data: mockPrompt, isLoading: false, error: null }),
  usePatchRepo: () => ({ mutate: vi.fn() }),
  useDeleteRepo: () => ({ mutate: vi.fn() }),
}));

describe('RepoDetailPage', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_USE_MOCK', 'true');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function render() {
    return renderWithProviders(
      <Routes>
        <Route path="/repos/:id" element={<RepoDetailPage />} />
      </Routes>,
      { route: '/repos/repo-001' },
    );
  }

  it('renders the repo name', () => {
    render();
    expect(screen.getByText('acme/api-service')).toBeInTheDocument();
  });

  it('renders the platform badge [GH]', () => {
    render();
    expect(screen.getByText('[GH]')).toBeInTheDocument();
  });

  it('renders all four metric cards', () => {
    render();
    expect(screen.getByText('Total Reviews')).toBeInTheDocument();
    expect(screen.getByText('Last 30 Days')).toBeInTheDocument();
    expect(screen.getByText('Avg Duration (s)')).toBeInTheDocument();
    expect(screen.getByText('Total Cost (USD)')).toBeInTheDocument();
  });

  it('renders the Recent Reviews section', () => {
    render();
    expect(screen.getByText('Recent Reviews')).toBeInTheDocument();
  });

  it('renders the [EDIT PROMPT] link pointing to /repos/repo-001/prompt', () => {
    render();
    const editLinks = screen.getAllByRole('link', { name: '[EDIT PROMPT]' });
    const hrefs = editLinks.map((el) => el.getAttribute('href'));
    expect(hrefs).toContain('/repos/repo-001/prompt');
  });

  it('shows [CUSTOM PROMPT] meta and prompt preview text', () => {
    render();
    expect(screen.getByText(/\[CUSTOM PROMPT\]/)).toBeInTheDocument();
    expect(screen.getByText(/You are an expert software engineer/)).toBeInTheDocument();
  });
});
