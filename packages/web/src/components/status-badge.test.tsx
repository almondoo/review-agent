import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { StatusBadge } from './status-badge.js';

describe('StatusBadge', () => {
  it('renders [OK] for approved', () => {
    render(<StatusBadge status="approved" />);
    expect(screen.getByText('[OK]')).toBeInTheDocument();
  });

  it('renders [OK] for ok', () => {
    render(<StatusBadge status="ok" />);
    expect(screen.getByText('[OK]')).toBeInTheDocument();
  });

  it('renders [OK] for configured', () => {
    render(<StatusBadge status="configured" />);
    expect(screen.getByText('[OK]')).toBeInTheDocument();
  });

  it('renders [REVIEW] for changes_requested', () => {
    render(<StatusBadge status="changes_requested" />);
    expect(screen.getByText('[REVIEW]')).toBeInTheDocument();
  });

  it('renders [NOTED] for commented', () => {
    render(<StatusBadge status="commented" />);
    expect(screen.getByText('[NOTED]')).toBeInTheDocument();
  });

  it('renders [FAIL] for failed', () => {
    render(<StatusBadge status="failed" />);
    expect(screen.getByText('[FAIL]')).toBeInTheDocument();
  });

  it('renders [QUEUED] for queued', () => {
    render(<StatusBadge status="queued" />);
    expect(screen.getByText('[QUEUED]')).toBeInTheDocument();
  });

  it('renders [STALE] for stale', () => {
    render(<StatusBadge status="stale" />);
    expect(screen.getByText('[STALE]')).toBeInTheDocument();
  });

  it('renders [NONE] for unconfigured', () => {
    render(<StatusBadge status="unconfigured" />);
    expect(screen.getByText('[NONE]')).toBeInTheDocument();
  });

  it('applies moss color for approved', () => {
    render(<StatusBadge status="approved" />);
    const el = screen.getByText('[OK]');
    expect(el).toHaveStyle({ color: 'var(--moss)' });
  });

  it('applies rust color for changes_requested', () => {
    render(<StatusBadge status="changes_requested" />);
    const el = screen.getByText('[REVIEW]');
    expect(el).toHaveStyle({ color: 'var(--rust)' });
  });

  it('applies graphite color for queued', () => {
    render(<StatusBadge status="queued" />);
    const el = screen.getByText('[QUEUED]');
    expect(el).toHaveStyle({ color: 'var(--graphite)' });
  });
});
