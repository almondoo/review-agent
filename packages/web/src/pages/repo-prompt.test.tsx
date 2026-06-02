import { act, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RepoDetail, RepoPrompt } from '../api/types.js';
import { renderWithDataRouter } from '../test/render.js';
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

// Mock useBlocker so that navigation tests do not rely on actual data-router
// navigation in jsdom (which triggers Node's undici Request constructor and
// fails with an AbortSignal mismatch in the jsdom environment).
// We test the guard's behaviour by controlling the blocker state directly.
const mockBlockerProceed = vi.fn();
const mockBlockerReset = vi.fn();
let mockBlockerState: 'idle' | 'blocked' | 'proceeding' = 'idle';

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return {
    ...actual,
    useBlocker: (fn: Parameters<typeof actual.useBlocker>[0]) => {
      // Call the condition function with stub locations to set the state.
      // The mock ignores the actual condition — callers set mockBlockerState directly.
      void fn;
      if (mockBlockerState === 'blocked') {
        return { state: 'blocked', proceed: mockBlockerProceed, reset: mockBlockerReset };
      }
      return { state: mockBlockerState };
    },
  };
});

describe('RepoPromptPage', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_USE_MOCK', 'true');
    mockMutate.mockReset();
    mockBlockerProceed.mockReset();
    mockBlockerReset.mockReset();
    mockBlockerState = 'idle';
    mockIsPending = false;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function render() {
    return renderWithDataRouter([{ path: '/repos/:id/prompt', element: <RepoPromptPage /> }], {
      initialEntries: ['/repos/repo-001/prompt'],
    });
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

  // Navigation guard tests — blocker state is controlled via mockBlockerState
  // to avoid triggering actual data-router navigation in jsdom.

  it('shows ConfirmDialog when blocker is in blocked state', () => {
    mockBlockerState = 'blocked';
    render();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '[LEAVE]' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '[STAY]' })).toBeInTheDocument();
  });

  it('calls blocker.reset() when [STAY] is clicked', async () => {
    mockBlockerState = 'blocked';
    render();
    const stayButton = screen.getByRole('button', { name: '[STAY]' });
    await act(async () => {
      fireEvent.click(stayButton);
    });
    expect(mockBlockerReset).toHaveBeenCalledTimes(1);
    expect(mockBlockerProceed).not.toHaveBeenCalled();
  });

  it('calls blocker.proceed() when [LEAVE] is clicked', async () => {
    mockBlockerState = 'blocked';
    render();
    const leaveButton = screen.getByRole('button', { name: '[LEAVE]' });
    await act(async () => {
      fireEvent.click(leaveButton);
    });
    expect(mockBlockerProceed).toHaveBeenCalledTimes(1);
    expect(mockBlockerReset).not.toHaveBeenCalled();
  });

  it('does NOT show ConfirmDialog when blocker is idle (clean form)', () => {
    mockBlockerState = 'idle';
    render();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('does NOT show ConfirmDialog after saving (isDirty becomes false)', () => {
    // After a successful save, savedRef.current === draft, so isDirty = false.
    // Simulate: render the page, save, then check that dialog is not shown.
    mockBlockerState = 'idle';
    mockMutate.mockImplementation((_vars: unknown, opts: { onSuccess?: () => void }) => {
      opts.onSuccess?.();
    });
    render();
    const textarea = screen.getByRole('textbox', { name: 'System prompt editor' });
    fireEvent.change(textarea, { target: { value: 'new content' } });
    // The [SAVE] button is now enabled
    const saveButton = screen.getByRole('button', { name: '[SAVE]' });
    fireEvent.click(saveButton);
    // After save, the [UNSAVED] indicator should be gone (isDirty = false)
    expect(screen.queryByText('[UNSAVED]')).toBeNull();
    // Blocker is idle so no dialog
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
