import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../test/render.js';
import { ErrorState } from './error-state.js';

describe('ErrorState', () => {
  it('renders the error message', () => {
    renderWithProviders(<ErrorState message="Something went wrong." />);
    expect(screen.getByText('Something went wrong.')).toBeInTheDocument();
  });

  it('does not render retry button when onRetry is not provided', () => {
    renderWithProviders(<ErrorState message="Error." />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('renders retry button with default label when onRetry is provided', () => {
    renderWithProviders(<ErrorState message="Error." onRetry={() => undefined} />);
    expect(screen.getByRole('button', { name: '[RETRY]' })).toBeInTheDocument();
  });

  it('renders retry button with custom retryLabel', () => {
    renderWithProviders(
      <ErrorState message="Error." onRetry={() => undefined} retryLabel="[TRY AGAIN]" />,
    );
    expect(screen.getByRole('button', { name: '[TRY AGAIN]' })).toBeInTheDocument();
  });

  it('calls onRetry when retry button is clicked', async () => {
    const onRetry = vi.fn();
    renderWithProviders(<ErrorState message="Error." onRetry={onRetry} />);
    screen.getByRole('button').click();
    expect(onRetry).toHaveBeenCalledOnce();
  });
});
