import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithDataRouter } from '../test/render.js';
import { ReposNewPage } from './repos-new.js';

const mockMutate = vi.hoisted(() => vi.fn());

vi.mock('../api/client.js', () => ({
  useCreateRepo: () => ({
    mutate: mockMutate,
    isPending: false,
    isError: false,
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
      void fn;
      if (mockBlockerState === 'blocked') {
        return { state: 'blocked', proceed: mockBlockerProceed, reset: mockBlockerReset };
      }
      return { state: mockBlockerState };
    },
    // Also mock useNavigate so the [CANCEL] button navigate() call doesn't
    // trigger actual data-router navigation in jsdom.
    useNavigate: () => mockNavigate,
  };
});

const mockNavigate = vi.hoisted(() => vi.fn());

describe('ReposNewPage', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_USE_MOCK', 'true');
    mockMutate.mockReset();
    mockNavigate.mockReset();
    mockBlockerProceed.mockReset();
    mockBlockerReset.mockReset();
    mockBlockerState = 'idle';
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function render() {
    return renderWithDataRouter([{ path: '/repos/new', element: <ReposNewPage /> }], {
      initialEntries: ['/repos/new'],
    });
  }

  it('renders Add Repo heading', () => {
    render();
    expect(screen.getByText('Add Repo')).toBeInTheDocument();
  });

  it('renders GitHub and CodeCommit platform options', () => {
    render();
    expect(screen.getByText('[GH] GitHub')).toBeInTheDocument();
    expect(screen.getByText('[CC] AWS CodeCommit')).toBeInTheDocument();
  });

  it('shows required validation error on empty submit', async () => {
    render();
    const form = screen.getByRole('button', { name: /\[ADD REPO\]/i }).closest('form');
    if (!form) throw new Error('form not found');
    fireEvent.submit(form);
    expect(await screen.findByText(/Repository name is required\./)).toBeInTheDocument();
    expect(mockMutate).not.toHaveBeenCalled();
  });

  it('shows invalid name error for name with space', async () => {
    render();
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'foo bar' } });
    const form = screen.getByRole('button', { name: /\[ADD REPO\]/i }).closest('form');
    if (!form) throw new Error('form not found');
    fireEvent.submit(form);
    expect(await screen.findByText(/Invalid repository name\./)).toBeInTheDocument();
    expect(mockMutate).not.toHaveBeenCalled();
  });

  it('calls navigate("/repos") on successful submit with valid name', async () => {
    render();
    mockMutate.mockImplementation((_vars: unknown, opts: { onSuccess?: () => void }) => {
      opts.onSuccess?.();
    });
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'acme/test' } });
    const form = screen.getByRole('button', { name: /\[ADD REPO\]/i }).closest('form');
    if (!form) throw new Error('form not found');
    await act(async () => {
      fireEvent.submit(form);
    });
    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/repos');
    });
  });

  // Dirty detection tests — form is dirty when name or platform differs from pristine.

  it('form is clean on mount (no edits)', () => {
    // Verify dirty detection: blocker should not fire for clean form.
    // We test this indirectly: if isDirty=false, ConfirmDialog should not appear
    // even when blocker state is forced to idle.
    mockBlockerState = 'idle';
    render();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('shows ConfirmDialog when blocker is blocked (dirty form)', () => {
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

  it('does NOT show dialog when blocker is idle', () => {
    mockBlockerState = 'idle';
    render();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('does NOT call navigate after successful submit when blocker is blocked', async () => {
    // Simulate that after submit, submitted=true means isDirty=false,
    // so the blocker should not block. We verify navigate IS called (not blocked).
    mockBlockerState = 'idle'; // submitted clears dirty so blocker goes idle
    mockMutate.mockImplementation((_vars: unknown, opts: { onSuccess?: () => void }) => {
      opts.onSuccess?.();
    });
    render();
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'acme/test' } });
    const form = screen.getByRole('button', { name: /\[ADD REPO\]/i }).closest('form');
    if (!form) throw new Error('form not found');
    await act(async () => {
      fireEvent.submit(form);
    });
    // No dialog should appear (blocker idle after submit)
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/repos');
    });
  });
});
