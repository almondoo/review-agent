import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PlatformBadge } from './platform-badge.js';

describe('PlatformBadge', () => {
  it('renders [GH] for github', () => {
    render(<PlatformBadge platform="github" />);
    expect(screen.getByText('[GH]')).toBeInTheDocument();
  });

  it('renders [CC] for codecommit', () => {
    render(<PlatformBadge platform="codecommit" />);
    expect(screen.getByText('[CC]')).toBeInTheDocument();
  });

  it('applies ink color for github', () => {
    render(<PlatformBadge platform="github" />);
    const el = screen.getByText('[GH]');
    expect(el).toHaveStyle({ color: 'var(--ink)' });
  });

  it('applies graphite color for codecommit', () => {
    render(<PlatformBadge platform="codecommit" />);
    const el = screen.getByText('[CC]');
    expect(el).toHaveStyle({ color: 'var(--graphite)' });
  });
});
