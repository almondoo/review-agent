import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderWithProviders } from '../test/render.js';
import { EmptyState } from './empty-state.js';

describe('EmptyState', () => {
  it('renders the empty message', () => {
    renderWithProviders(<EmptyState message="No items found." />);
    expect(screen.getByText('No items found.')).toBeInTheDocument();
  });

  it('does not render a CTA link when ctaLabel/ctaHref are omitted', () => {
    renderWithProviders(<EmptyState message="Empty." />);
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('renders a CTA link when ctaLabel and ctaHref are provided', () => {
    renderWithProviders(
      <EmptyState message="Empty." ctaLabel="[GO SOMEWHERE]" ctaHref="/somewhere" />,
    );
    const link = screen.getByRole('link', { name: '[GO SOMEWHERE]' });
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute('href', '/somewhere');
  });
});
