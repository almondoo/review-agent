import { fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getMockReviewDetail } from '../api/mocks.js';
import type { ReviewEventDetail } from '../api/types.js';
import { renderWithProviders } from '../test/render.js';
import { HistoryDetailPage } from './history-detail.js';

// Hoist mock factory so vi.mock hoisting can capture mutable state
const mockId = vi.hoisted(() => ({ current: 'rev-001' }));
const mockExternalUrlOverride = vi.hoisted(() => ({
  current: undefined as string | null | undefined,
}));

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return {
    ...actual,
    useParams: () => ({ id: mockId.current }),
  };
});

vi.mock('../api/client.js', async () => {
  const { getMockReviewDetail: getDetail } = await import('../api/mocks.js');
  const { useQuery } = await import('@tanstack/react-query');

  return {
    useReviewDetail: (id: string) =>
      useQuery({
        queryKey: ['review-detail-mock', id, mockExternalUrlOverride.current],
        queryFn: () => {
          const detail = getDetail(id);
          if (!detail) throw new Error(`Review ${id} not found`);
          const override = mockExternalUrlOverride.current;
          const resolved: ReviewEventDetail =
            override !== undefined ? { ...detail, externalUrl: override } : detail;
          return Promise.resolve(resolved);
        },
        retry: false,
      }),
  };
});

describe('HistoryDetailPage', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_USE_MOCK', 'true');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('rev-001 (changes_requested, 3 comments)', () => {
    beforeEach(() => {
      mockId.current = 'rev-001';
    });

    it('renders the PR title in the heading', async () => {
      renderWithProviders(<HistoryDetailPage />, { route: '/history/rev-001' });
      const detail = getMockReviewDetail('rev-001');
      if (!detail) throw new Error('mock not found');
      expect(
        await screen.findByText(new RegExp(detail.pr.title.replace(/[[\]/]/g, '\\$&'))),
      ).toBeInTheDocument();
    });

    it('renders at least one path:line comment entry', async () => {
      renderWithProviders(<HistoryDetailPage />, { route: '/history/rev-001' });
      // path:line label for the first comment (src/middleware/rate-limit.ts:42)
      expect(await screen.findByText('src/middleware/rate-limit.ts:42')).toBeInTheDocument();
    });

    it('renders "View PR ↗" as an anchor link with correct href', async () => {
      renderWithProviders(<HistoryDetailPage />, { route: '/history/rev-001' });
      const link = await screen.findByRole('link', { name: 'View PR ↗' });
      expect(link).toBeInTheDocument();
      expect(link).toHaveAttribute('href', 'https://github.com/acme/api-service/pull/214');
    });

    it('renders "Repository →" link pointing to /repos/repo-001', async () => {
      renderWithProviders(<HistoryDetailPage />, { route: '/history/rev-001' });
      const link = await screen.findByRole('link', { name: 'Repository →' });
      expect(link).toBeInTheDocument();
      expect(link).toHaveAttribute('href', '/repos/repo-001');
    });

    it('renders "Edit current prompt →" link pointing to /repos/repo-001/prompt', async () => {
      renderWithProviders(<HistoryDetailPage />, { route: '/history/rev-001' });
      const link = await screen.findByRole('link', { name: 'Edit current prompt →' });
      expect(link).toBeInTheDocument();
      expect(link).toHaveAttribute('href', '/repos/repo-001/prompt');
    });
  });

  describe('rev-003 (comments=[])', () => {
    beforeEach(() => {
      mockId.current = 'rev-003';
    });

    it('shows [ NO INLINE COMMENTS POSTED ] when comments array is empty', async () => {
      renderWithProviders(<HistoryDetailPage />, { route: '/history/rev-003' });
      expect(await screen.findByText('[ NO INLINE COMMENTS POSTED ]')).toBeInTheDocument();
    });
  });

  describe('rev-005 (systemPromptAtReview=null)', () => {
    beforeEach(() => {
      mockId.current = 'rev-005';
    });

    it('shows [NULL] No snapshot. in the system prompt details after opening', async () => {
      renderWithProviders(<HistoryDetailPage />, { route: '/history/rev-005' });

      // Wait for the page to render then click to open details
      const toggle = await screen.findByText('[SHOW PROMPT]');
      fireEvent.click(toggle);

      expect(screen.getByText('[NULL] No snapshot.')).toBeInTheDocument();
    });
  });

  describe('XSS guard — isSafeExternalUrl', () => {
    beforeEach(() => {
      mockId.current = 'rev-001';
    });

    afterEach(() => {
      mockExternalUrlOverride.current = undefined;
    });

    it('renders "View PR ↗" as a span (not anchor) when externalUrl uses javascript: scheme', async () => {
      mockExternalUrlOverride.current = 'javascript:alert(1)';
      renderWithProviders(<HistoryDetailPage />, { route: '/history/rev-001' });
      const el = await screen.findByText('View PR ↗');
      expect(el.closest('a')).toBeNull();
      expect(el).not.toHaveAttribute('href');
    });

    it('renders "View PR ↗" as an anchor when externalUrl is a valid https URL', async () => {
      mockExternalUrlOverride.current = 'https://github.com/acme/repo/pull/1';
      renderWithProviders(<HistoryDetailPage />, { route: '/history/rev-001' });
      const link = await screen.findByRole('link', { name: 'View PR ↗' });
      expect(link).toHaveAttribute('href', 'https://github.com/acme/repo/pull/1');
    });
  });
});
