import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithDataRouter } from '../test/render.js';
import { LoginPage } from './login.js';

// --- Mocks ----------------------------------------------------------------

const mockNavigate = vi.hoisted(() => vi.fn());

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

// Mock apiLogin — control success/failure per test.
const mockApiLogin = vi.hoisted(() => vi.fn());
const mockInvalidateQueries = vi.hoisted(() => vi.fn());

vi.mock('../api/client.js', () => ({
  apiLogin: mockApiLogin,
  IS_MOCK: false,
}));

vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>();
  return {
    ...actual,
    useQueryClient: () => ({
      invalidateQueries: mockInvalidateQueries,
    }),
  };
});

// Mock setSessionToken so we can assert it was called.
const mockSetSessionToken = vi.hoisted(() => vi.fn());

vi.mock('../lib/session-token.js', () => ({
  getSessionToken: () => null,
  setSessionToken: mockSetSessionToken,
  clearSessionToken: vi.fn(),
}));

// --- Helpers ---------------------------------------------------------------

function render() {
  return renderWithDataRouter([{ path: '/login', element: <LoginPage /> }], {
    initialEntries: ['/login'],
  });
}

function fillAndSubmit(username = 'alice', password = 'secret') {
  fireEvent.change(screen.getByRole('textbox', { name: /username/i }), {
    target: { value: username },
  });
  const passwordInput = screen.getByPlaceholderText('Enter your password');
  fireEvent.change(passwordInput, { target: { value: password } });
  const form = passwordInput.closest('form');
  if (!form) throw new Error('form not found');
  fireEvent.submit(form);
}

// --- Tests -----------------------------------------------------------------

describe('LoginPage', () => {
  beforeEach(() => {
    mockNavigate.mockReset();
    mockApiLogin.mockReset();
    mockSetSessionToken.mockReset();
    mockInvalidateQueries.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('renders the page title', () => {
    render();
    expect(screen.getByText('Log in')).toBeInTheDocument();
  });

  it('renders username and password inputs', () => {
    render();
    expect(screen.getByRole('textbox', { name: /username/i })).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Enter your password')).toBeInTheDocument();
  });

  it('password input is type=password', () => {
    render();
    const passwordInput = screen.getByPlaceholderText('Enter your password');
    expect(passwordInput).toHaveAttribute('type', 'password');
  });

  it('submit button is disabled when fields are empty', () => {
    render();
    const submitBtn = screen.getByRole('button', { name: /\[LOG IN\]/i });
    expect(submitBtn).toBeDisabled();
  });

  it('submit button is disabled when only username is filled', () => {
    render();
    fireEvent.change(screen.getByRole('textbox', { name: /username/i }), {
      target: { value: 'alice' },
    });
    const submitBtn = screen.getByRole('button', { name: /\[LOG IN\]/i });
    expect(submitBtn).toBeDisabled();
  });

  it('submit button becomes enabled when both fields are filled', () => {
    render();
    fireEvent.change(screen.getByRole('textbox', { name: /username/i }), {
      target: { value: 'alice' },
    });
    fireEvent.change(screen.getByPlaceholderText('Enter your password'), {
      target: { value: 'secret' },
    });
    const submitBtn = screen.getByRole('button', { name: /\[LOG IN\]/i });
    expect(submitBtn).not.toBeDisabled();
  });

  it('saves token and navigates to / on success', async () => {
    mockApiLogin.mockResolvedValue({ token: 'jwt-abc', expiresIn: 3600 });
    render();
    await act(async () => {
      fillAndSubmit();
    });
    await waitFor(() => {
      expect(mockSetSessionToken).toHaveBeenCalledWith('jwt-abc');
      expect(mockNavigate).toHaveBeenCalledWith('/', { replace: true });
    });
  });

  it('invalidates auth-me query after successful login', async () => {
    mockApiLogin.mockResolvedValue({ token: 'jwt-abc', expiresIn: 3600 });
    render();
    await act(async () => {
      fillAndSubmit();
    });
    await waitFor(() => {
      expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: ['auth-me'] });
    });
  });

  it('shows invalid credentials error on 401', async () => {
    mockApiLogin.mockRejectedValue(new Error('API error 401: Unauthorized'));
    render();
    await act(async () => {
      fillAndSubmit();
    });
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Incorrect username or password.');
    });
    expect(mockSetSessionToken).not.toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('shows legacy mode message on 404', async () => {
    mockApiLogin.mockRejectedValue(new Error('API error 404: Not Found'));
    render();
    await act(async () => {
      fillAndSubmit();
    });
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(
        'This deployment has per-user login disabled.',
      );
    });
  });

  it('clears error message when user starts typing again', async () => {
    mockApiLogin.mockRejectedValue(new Error('API error 401: Unauthorized'));
    render();
    await act(async () => {
      fillAndSubmit();
    });
    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });
    // Now type in the username field to clear the error.
    fireEvent.change(screen.getByRole('textbox', { name: /username/i }), {
      target: { value: 'alice2' },
    });
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
