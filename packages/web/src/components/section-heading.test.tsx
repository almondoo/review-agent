import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SectionHeading } from './section-heading.js';

describe('SectionHeading', () => {
  it('renders the title', () => {
    render(<SectionHeading title="Overview" />);
    expect(screen.getByRole('heading', { name: 'Overview' })).toBeInTheDocument();
  });

  it('does not render subtitle when omitted', () => {
    render(<SectionHeading title="Overview" />);
    expect(screen.queryByRole('paragraph')).toBeNull();
  });

  it('renders subtitle when provided', () => {
    render(<SectionHeading title="Overview" subtitle="Repo stats" />);
    expect(screen.getByText('Repo stats')).toBeInTheDocument();
  });
});
