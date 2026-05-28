import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderWithProviders } from '../test/render.js';
import { NotFoundPage } from './not-found.js';

describe('NotFoundPage', () => {
  it('renders the heading', () => {
    renderWithProviders(<NotFoundPage />);
    expect(screen.getByRole('heading', { name: 'Not here.' })).toBeInTheDocument();
  });

  it('renders the return link pointing to /', () => {
    renderWithProviders(<NotFoundPage />);
    const link = screen.getByRole('link', { name: '[← Return to Overview]' });
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute('href', '/');
  });

  it('renders the 404 / not-found mono label', () => {
    renderWithProviders(<NotFoundPage />);
    expect(screen.getByText('404 / not-found')).toBeInTheDocument();
  });
});
