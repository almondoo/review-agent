import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderWithProviders } from '../test/render.js';
import { Footer } from './footer.js';

describe('Footer', () => {
  it('renders a footer element', () => {
    renderWithProviders(<Footer />);
    expect(screen.getByRole('contentinfo')).toBeInTheDocument();
  });

  it('renders the how-it-works link with correct href', () => {
    renderWithProviders(<Footer />);
    const link = screen.getByRole('link', { name: 'HOW IT WORKS' });
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute('href', '/how-it-works');
  });

  it('renders the product label text', () => {
    renderWithProviders(<Footer />);
    expect(screen.getByText(/review-agent/i)).toBeInTheDocument();
  });
});
