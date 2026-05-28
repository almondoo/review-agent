import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../test/render.js';
import { ReposNewPage } from './repos-new.js';

const mockNavigate = vi.hoisted(() => vi.fn());
const mockMutate = vi.hoisted(() => vi.fn());

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

vi.mock('../api/client.js', () => ({
  useCreateRepo: () => ({
    mutate: mockMutate,
    isPending: false,
    isError: false,
  }),
}));

describe('ReposNewPage', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_USE_MOCK', 'true');
    mockNavigate.mockReset();
    mockMutate.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('renders Add Repo heading', () => {
    renderWithProviders(<ReposNewPage />, { route: '/repos/new' });
    expect(screen.getByText('Add Repo')).toBeInTheDocument();
  });

  it('renders GitHub and CodeCommit platform options', () => {
    renderWithProviders(<ReposNewPage />, { route: '/repos/new' });
    expect(screen.getByText('[GH] GitHub')).toBeInTheDocument();
    expect(screen.getByText('[CC] AWS CodeCommit')).toBeInTheDocument();
  });

  it('shows required validation error on empty submit', async () => {
    renderWithProviders(<ReposNewPage />, { route: '/repos/new' });
    const form = screen.getByRole('button', { name: /\[ADD REPO\]/i }).closest('form');
    if (!form) throw new Error('form not found');
    fireEvent.submit(form);
    expect(await screen.findByText(/Repository name is required\./)).toBeInTheDocument();
    expect(mockMutate).not.toHaveBeenCalled();
  });

  it('shows invalid name error for name with space', async () => {
    renderWithProviders(<ReposNewPage />, { route: '/repos/new' });
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'foo bar' } });
    const form = screen.getByRole('button', { name: /\[ADD REPO\]/i }).closest('form');
    if (!form) throw new Error('form not found');
    fireEvent.submit(form);
    expect(await screen.findByText(/Invalid repository name\./)).toBeInTheDocument();
    expect(mockMutate).not.toHaveBeenCalled();
  });

  it('navigates to /repos on successful submit with valid name', async () => {
    mockMutate.mockImplementation((_vars: unknown, opts: { onSuccess?: () => void }) => {
      opts.onSuccess?.();
    });
    renderWithProviders(<ReposNewPage />, { route: '/repos/new' });
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'acme/test' } });
    const form = screen.getByRole('button', { name: /\[ADD REPO\]/i }).closest('form');
    if (!form) throw new Error('form not found');
    fireEvent.submit(form);
    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/repos');
    });
  });
});
