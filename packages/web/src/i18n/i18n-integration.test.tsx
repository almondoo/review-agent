/**
 * i18n integration tests — verify that key pages render correctly under both
 * 'ja' and 'en' languages.  These tests use the i18n instance directly to
 * switch language between test cases and assert that the relevant translated
 * strings appear.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import i18n from 'i18next';
import type { ReactElement } from 'react';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter } from 'react-router-dom';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockOverview } from '../api/mocks.js';
import { NotFoundPage } from '../pages/not-found.js';
import { OverviewPage } from '../pages/overview.js';

vi.mock('../api/client.js', () => ({
  useOverview: () => ({ data: mockOverview, isLoading: false, error: null }),
}));

function renderWithLang(ui: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>{ui}</MemoryRouter>
      </QueryClientProvider>
    </I18nextProvider>,
  );
}

// Snapshot the language state before all tests and restore it afterwards.
let originalLang: string;

beforeAll(() => {
  originalLang = i18n.language;
});

afterAll(async () => {
  await i18n.changeLanguage(originalLang);
});

describe('OverviewPage — language switching', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en');
  });

  it('renders English title and subtitle when language is "en"', async () => {
    renderWithLang(<OverviewPage />);
    expect(await screen.findByText('Overview')).toBeInTheDocument();
    expect(screen.getByText('Dashboard — current state')).toBeInTheDocument();
  });

  it('renders Japanese title when language is "ja"', async () => {
    await i18n.changeLanguage('ja');
    renderWithLang(<OverviewPage />);
    expect(await screen.findByText('概要')).toBeInTheDocument();
    expect(screen.getByText('ダッシュボード — 現在の状態')).toBeInTheDocument();
  });

  it('renders English metric labels when language is "en"', async () => {
    renderWithLang(<OverviewPage />);
    expect(await screen.findByText('Total Repos')).toBeInTheDocument();
    expect(screen.getByText('Reviews / Month')).toBeInTheDocument();
  });

  it('renders Japanese metric labels when language is "ja"', async () => {
    await i18n.changeLanguage('ja');
    renderWithLang(<OverviewPage />);
    expect(await screen.findByText('総リポジトリ数')).toBeInTheDocument();
    expect(screen.getByText('レビュー数 / 月')).toBeInTheDocument();
  });
});

describe('NotFoundPage — language switching', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en');
  });

  it('renders English 404 heading when language is "en"', () => {
    renderWithLang(<NotFoundPage />);
    expect(screen.getByRole('heading', { name: 'Not here.' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '[← Return to Overview]' })).toBeInTheDocument();
  });

  it('renders Japanese 404 heading when language is "ja"', async () => {
    await i18n.changeLanguage('ja');
    renderWithLang(<NotFoundPage />);
    expect(screen.getByRole('heading', { name: 'ここには何もありません。' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '[← 概要に戻る]' })).toBeInTheDocument();
  });
});
