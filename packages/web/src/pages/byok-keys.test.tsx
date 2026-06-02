import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithDataRouter } from '../test/render.js';
import { ByokKeysPage } from './byok-keys.js';

// --- Mocks ----------------------------------------------------------------

const mockUpsertMutate = vi.hoisted(() => vi.fn());
const mockRotateMutate = vi.hoisted(() => vi.fn());
const mockDeleteMutate = vi.hoisted(() => vi.fn());

// Default mock data for useLlmKeys
const mockKeysData = {
  installationId: 1,
  keys: [
    { provider: 'anthropic', configured: true },
    { provider: 'openai', configured: false },
    { provider: 'azure-openai', configured: false },
    { provider: 'google', configured: false },
    { provider: 'vertex', configured: false },
    { provider: 'bedrock', configured: false },
    { provider: 'openai-compatible', configured: false },
  ],
};

let mockLlmKeysResult: {
  data: typeof mockKeysData | undefined;
  isLoading: boolean;
  error: Error | null;
} = { data: mockKeysData, isLoading: false, error: null };

vi.mock('../api/client.js', () => ({
  useLlmKeys: () => mockLlmKeysResult,
  useUpsertLlmKey: () => ({
    mutate: mockUpsertMutate,
    isPending: false,
  }),
  useRotateLlmKey: () => ({
    mutate: mockRotateMutate,
    isPending: false,
  }),
  useDeleteLlmKey: () => ({
    mutate: mockDeleteMutate,
    isPending: false,
  }),
}));

// Mock useBlocker as per the pattern in repos-new.test.tsx
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
  };
});

// --- Helpers ---------------------------------------------------------------

function render() {
  return renderWithDataRouter([{ path: '/integrations/keys', element: <ByokKeysPage /> }], {
    initialEntries: ['/integrations/keys'],
  });
}

function enterInstallationId(id = '1') {
  const input = screen.getByRole('textbox', { name: /installation id/i });
  fireEvent.change(input, { target: { value: id } });
  fireEvent.click(screen.getByRole('button', { name: /\[save\]/i }));
}

async function loadKeyList() {
  render();
  enterInstallationId('1');
  // Wait for the key status grid to appear. [CONFIGURED] only appears in the
  // status column rows, never in form labels or select options.
  await waitFor(() => {
    expect(screen.getByText('[CONFIGURED]')).toBeInTheDocument();
  });
}

// --- Tests -----------------------------------------------------------------

describe('ByokKeysPage', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_USE_MOCK', 'true');
    mockUpsertMutate.mockReset();
    mockRotateMutate.mockReset();
    mockDeleteMutate.mockReset();
    mockBlockerProceed.mockReset();
    mockBlockerReset.mockReset();
    mockBlockerState = 'idle';
    mockLlmKeysResult = { data: mockKeysData, isLoading: false, error: null };
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('renders the page title', () => {
    render();
    expect(screen.getByText('LLM API Key Management')).toBeInTheDocument();
  });

  it('shows placeholder text before installation ID is set', () => {
    render();
    expect(
      screen.getByText('Enter an installation ID to view and manage keys.'),
    ).toBeInTheDocument();
  });

  it('shows validation error for empty installation ID', () => {
    render();
    fireEvent.click(screen.getByRole('button', { name: /\[save\]/i }));
    expect(screen.getByText('Installation ID is required.')).toBeInTheDocument();
  });

  it('shows validation error for invalid installation ID', () => {
    render();
    const input = screen.getByRole('textbox', { name: /installation id/i });
    fireEvent.change(input, { target: { value: 'abc' } });
    fireEvent.click(screen.getByRole('button', { name: /\[save\]/i }));
    expect(screen.getByText('Enter a valid positive integer.')).toBeInTheDocument();
  });

  it('shows validation error for zero installation ID', () => {
    render();
    const input = screen.getByRole('textbox', { name: /installation id/i });
    fireEvent.change(input, { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: /\[save\]/i }));
    expect(screen.getByText('Enter a valid positive integer.')).toBeInTheDocument();
  });

  it('renders provider list after valid installation ID is entered', async () => {
    await loadKeyList();
    // Provider names appear both in table rows AND in the select options.
    expect(screen.getAllByText('OpenAI').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Azure OpenAI').length).toBeGreaterThanOrEqual(1);
  });

  it('renders configured status for anthropic', async () => {
    await loadKeyList();
    // anthropic is configured=true; should show at least one [CONFIGURED]
    const configuredBadges = screen.getAllByText('[CONFIGURED]');
    expect(configuredBadges.length).toBeGreaterThanOrEqual(1);
  });

  it('renders not-configured status for openai', async () => {
    await loadKeyList();
    const notConfiguredBadges = screen.getAllByText('[NOT CONFIGURED]');
    expect(notConfiguredBadges.length).toBeGreaterThanOrEqual(1);
  });

  it('shows loading state', async () => {
    mockLlmKeysResult = { data: undefined, isLoading: true, error: null };
    render();
    enterInstallationId('1');
    await waitFor(() => {
      expect(screen.getByText('[LOADING...]')).toBeInTheDocument();
    });
  });

  it('shows error state', async () => {
    mockLlmKeysResult = {
      data: undefined,
      isLoading: false,
      error: new Error('Network error'),
    };
    render();
    enterInstallationId('1');
    await waitFor(() => {
      expect(screen.getByText('[ERROR] Failed to load keys.')).toBeInTheDocument();
    });
  });

  it('opens ConfirmDialog when [ROTATE] is clicked for configured provider', async () => {
    await loadKeyList();
    // The aria-label includes the provider name from t(PROVIDER_LABEL_KEYS[provider])
    const rotateAnthropicBtn = screen.getByRole('button', { name: /\[ROTATE\] Anthropic/i });
    await act(async () => {
      fireEvent.click(rotateAnthropicBtn);
    });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('Rotate key')).toBeInTheDocument();
  });

  it('calls rotateMutate after confirming rotate', async () => {
    await loadKeyList();
    const rotateAnthropicBtn = screen.getByRole('button', { name: /\[ROTATE\] Anthropic/i });
    await act(async () => {
      fireEvent.click(rotateAnthropicBtn);
    });
    // The dialog's confirm button text is [ROTATE]
    const confirmButton = screen.getByRole('button', { name: '[ROTATE]' });
    await act(async () => {
      fireEvent.click(confirmButton);
    });
    expect(mockRotateMutate).toHaveBeenCalledTimes(1);
    expect(mockRotateMutate).toHaveBeenCalledWith(
      { installationId: 1, provider: 'anthropic' },
      expect.any(Object),
    );
  });

  it('does NOT call rotateMutate when rotate is cancelled', async () => {
    await loadKeyList();
    const rotateAnthropicBtn = screen.getByRole('button', { name: /\[ROTATE\] Anthropic/i });
    await act(async () => {
      fireEvent.click(rotateAnthropicBtn);
    });
    const cancelButton = screen.getByRole('button', { name: '[CANCEL]' });
    await act(async () => {
      fireEvent.click(cancelButton);
    });
    expect(mockRotateMutate).not.toHaveBeenCalled();
    // Dialog should be closed
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('opens ConfirmDialog when [REMOVE] is clicked for configured provider', async () => {
    await loadKeyList();
    const removeAnthropicBtn = screen.getByRole('button', { name: /\[REMOVE\] Anthropic/i });
    await act(async () => {
      fireEvent.click(removeAnthropicBtn);
    });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('Remove key')).toBeInTheDocument();
  });

  it('calls deleteMutate after confirming remove', async () => {
    await loadKeyList();
    const removeAnthropicBtn = screen.getByRole('button', { name: /\[REMOVE\] Anthropic/i });
    await act(async () => {
      fireEvent.click(removeAnthropicBtn);
    });
    const confirmButton = screen.getByRole('button', { name: '[REMOVE]' });
    await act(async () => {
      fireEvent.click(confirmButton);
    });
    expect(mockDeleteMutate).toHaveBeenCalledTimes(1);
    expect(mockDeleteMutate).toHaveBeenCalledWith(
      { installationId: 1, provider: 'anthropic' },
      expect.any(Object),
    );
  });

  it('apiKey input is type=password by default', async () => {
    await loadKeyList();
    const passwordInput = screen.getByPlaceholderText('sk-...');
    expect(passwordInput).toHaveAttribute('type', 'password');
  });

  it('shows key after clicking show/hide toggle', async () => {
    await loadKeyList();
    const passwordInput = screen.getByPlaceholderText('sk-...');
    expect(passwordInput).toHaveAttribute('type', 'password');
    const toggleBtn = screen.getByRole('button', { name: /toggle api key visibility/i });
    fireEvent.click(toggleBtn);
    expect(passwordInput).toHaveAttribute('type', 'text');
  });

  it('hides key again after second toggle click', async () => {
    await loadKeyList();
    const toggleBtn = screen.getByRole('button', { name: /toggle api key visibility/i });
    fireEvent.click(toggleBtn); // show
    fireEvent.click(toggleBtn); // hide
    const passwordInput = screen.getByPlaceholderText('sk-...');
    expect(passwordInput).toHaveAttribute('type', 'password');
  });

  it('clears apiKey input after successful submit', async () => {
    mockUpsertMutate.mockImplementation((_vars: unknown, opts: { onSuccess?: () => void }) => {
      opts.onSuccess?.();
    });
    await loadKeyList();
    const apiKeyInput = screen.getByPlaceholderText('sk-...');
    fireEvent.change(apiKeyInput, { target: { value: 'sk-secret123' } });
    expect(apiKeyInput).toHaveValue('sk-secret123');

    const form = apiKeyInput.closest('form');
    if (!form) throw new Error('form not found');
    await act(async () => {
      fireEvent.submit(form);
    });
    expect(apiKeyInput).toHaveValue('');
  });

  it('stored key is never rendered in the DOM', async () => {
    await loadKeyList();
    // The API returns only `configured: boolean`, never the key value itself.
    expect(screen.queryByText(/sk-/)).toBeNull();
  });

  // Unsaved-changes guard tests

  it('form is clean on mount (no edits) — dialog not shown', async () => {
    mockBlockerState = 'idle';
    await loadKeyList();
    expect(screen.queryByText('Unsaved changes')).toBeNull();
  });

  it('shows UnsavedChangesDialog when blocker is blocked', () => {
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
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '[STAY]' }));
    });
    expect(mockBlockerReset).toHaveBeenCalledTimes(1);
    expect(mockBlockerProceed).not.toHaveBeenCalled();
  });

  it('calls blocker.proceed() when [LEAVE] is clicked', async () => {
    mockBlockerState = 'blocked';
    render();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '[LEAVE]' }));
    });
    expect(mockBlockerProceed).toHaveBeenCalledTimes(1);
    expect(mockBlockerReset).not.toHaveBeenCalled();
  });

  it('does NOT show unsaved dialog after successful submit (blocker idle)', async () => {
    mockUpsertMutate.mockImplementation((_vars: unknown, opts: { onSuccess?: () => void }) => {
      opts.onSuccess?.();
    });
    mockBlockerState = 'idle';
    await loadKeyList();
    const apiKeyInput = screen.getByPlaceholderText('sk-...');
    fireEvent.change(apiKeyInput, { target: { value: 'sk-test-key' } });
    const form = apiKeyInput.closest('form');
    if (!form) throw new Error('form not found');
    await act(async () => {
      fireEvent.submit(form);
    });
    // Blocker is idle => no unsaved changes dialog
    expect(screen.queryByText('Unsaved changes')).toBeNull();
  });

  it('shows success toast after upsert', async () => {
    mockUpsertMutate.mockImplementation((_vars: unknown, opts: { onSuccess?: () => void }) => {
      opts.onSuccess?.();
    });
    await loadKeyList();
    const apiKeyInput = screen.getByPlaceholderText('sk-...');
    fireEvent.change(apiKeyInput, { target: { value: 'sk-test' } });
    const form = apiKeyInput.closest('form');
    if (!form) throw new Error('form not found');
    await act(async () => {
      fireEvent.submit(form);
    });
    await waitFor(() => {
      expect(screen.getByText('[OK] API key saved.')).toBeInTheDocument();
    });
  });

  it('shows error toast after upsert failure', async () => {
    mockUpsertMutate.mockImplementation((_vars: unknown, opts: { onError?: () => void }) => {
      opts.onError?.();
    });
    await loadKeyList();
    const apiKeyInput = screen.getByPlaceholderText('sk-...');
    fireEvent.change(apiKeyInput, { target: { value: 'sk-test' } });
    const form = apiKeyInput.closest('form');
    if (!form) throw new Error('form not found');
    await act(async () => {
      fireEvent.submit(form);
    });
    await waitFor(() => {
      expect(screen.getByText('[FAIL] Failed to save API key.')).toBeInTheDocument();
    });
  });

  it('shows success toast after rotate', async () => {
    mockRotateMutate.mockImplementation((_vars: unknown, opts: { onSuccess?: () => void }) => {
      opts.onSuccess?.();
    });
    await loadKeyList();
    const rotateAnthropicBtn = screen.getByRole('button', { name: /\[ROTATE\] Anthropic/i });
    await act(async () => {
      fireEvent.click(rotateAnthropicBtn);
    });
    const confirmButton = screen.getByRole('button', { name: '[ROTATE]' });
    await act(async () => {
      fireEvent.click(confirmButton);
    });
    await waitFor(() => {
      expect(screen.getByText('[OK] Key rotated.')).toBeInTheDocument();
    });
  });

  it('shows success toast after remove', async () => {
    mockDeleteMutate.mockImplementation((_vars: unknown, opts: { onSuccess?: () => void }) => {
      opts.onSuccess?.();
    });
    await loadKeyList();
    const removeAnthropicBtn = screen.getByRole('button', { name: /\[REMOVE\] Anthropic/i });
    await act(async () => {
      fireEvent.click(removeAnthropicBtn);
    });
    const confirmButton = screen.getByRole('button', { name: '[REMOVE]' });
    await act(async () => {
      fireEvent.click(confirmButton);
    });
    await waitFor(() => {
      expect(screen.getByText('[OK] Key removed.')).toBeInTheDocument();
    });
  });

  it('renders under the i18n harness with correct page title', () => {
    render();
    expect(screen.getByText('LLM API Key Management')).toBeInTheDocument();
    expect(screen.getByText('Configure per-installation provider keys (BYOK)')).toBeInTheDocument();
  });
});
