import { fireEvent, screen } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RepoDetail, RepoPrompt } from '../api/types.js';
import { renderWithProviders } from '../test/render.js';
import { RepoPromptPage } from './repo-prompt.js';

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

const mockRepoPrompt: RepoPrompt = {
  systemPrompt: SAMPLE_SYSTEM_PROMPT,
  updatedAt: '2026-05-20T10:00:00Z',
};

const mockMutate = vi.fn();
let mockIsPending = false;

vi.mock('../api/client.js', () => ({
  useRepoDetail: (_id: string) => ({ data: mockRepoDetail, isLoading: false }),
  useRepoPrompt: (_id: string) => ({ data: mockRepoPrompt, isLoading: false }),
  usePutRepoPrompt: () => ({
    mutate: mockMutate,
    isPending: mockIsPending,
  }),
}));

describe('RepoPromptPage', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_USE_MOCK', 'true');
    mockMutate.mockReset();
    mockIsPending = false;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function render() {
    return renderWithProviders(
      <Routes>
        <Route path="/repos/:id/prompt" element={<RepoPromptPage />} />
      </Routes>,
      { route: '/repos/repo-001/prompt' },
    );
  }

  it('renders "System Prompt" heading', () => {
    render();
    expect(screen.getByRole('heading', { name: 'System Prompt' })).toBeInTheDocument();
  });

  it('shows repo name in breadcrumb', () => {
    render();
    const links = screen.getAllByRole('link', { name: 'acme/api-service' });
    expect(links.length).toBeGreaterThan(0);
  });

  it('renders textarea with initial value from mock prompt', () => {
    render();
    const textarea = screen.getByRole('textbox', { name: 'System prompt editor' });
    expect(textarea).toBeInTheDocument();
    expect((textarea as HTMLTextAreaElement).value).toContain(
      'You are an expert software engineer',
    );
  });

  it('shows [UNSAVED] indicator and dirty dot when textarea is edited', () => {
    render();
    const textarea = screen.getByRole('textbox', { name: 'System prompt editor' });
    fireEvent.change(textarea, { target: { value: 'edited prompt' } });
    expect(screen.getByText('[UNSAVED]')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Unsaved changes' })).toBeInTheDocument();
  });

  it('enables [SAVE] button when textarea is dirty', () => {
    render();
    const textarea = screen.getByRole('textbox', { name: 'System prompt editor' });
    const saveButton = screen.getByRole('button', { name: '[SAVE]' });
    expect(saveButton).toBeDisabled();
    fireEvent.change(textarea, { target: { value: 'new content' } });
    expect(saveButton).not.toBeDisabled();
  });

  it('displays a character count with toLocaleString formatting', () => {
    render();
    const charCount = screen
      .getAllByText(/chars$/)
      .find((el) => el.getAttribute('aria-live') === 'polite');
    expect(charCount).toBeDefined();
    expect(charCount?.textContent).toMatch(/[\d,]+ \/ 50,000 chars/);
  });

  it('does not call mutate a second time when isPending is true (double-invoke guard)', () => {
    // Simulate isPending=true so handleSave early-returns
    mockIsPending = true;
    render();
    const textarea = screen.getByRole('textbox', { name: 'System prompt editor' });
    // Make the form dirty so the save button would be enabled if not pending
    fireEvent.change(textarea, { target: { value: 'changed prompt' } });
    // Directly invoke via the button (disabled by isPending, but guard is in handleSave too)
    // Simulate two direct handleSave calls by clicking twice if button were not disabled,
    // but since handleSave guards via isPending, we verify mutate is never called
    const saveButton = screen.getByRole('button', { name: '[SAVING...]' });
    fireEvent.click(saveButton);
    fireEvent.click(saveButton);
    expect(mockMutate).not.toHaveBeenCalled();
  });
});
