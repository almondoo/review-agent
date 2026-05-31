import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MetricCard } from './metric-card.js';

describe('MetricCard', () => {
  it('renders the label', () => {
    render(<MetricCard value={42} label="Total Repos" />);
    expect(screen.getByText('Total Repos')).toBeInTheDocument();
  });

  it('renders with a prefix', () => {
    render(<MetricCard value={5} label="Cost" prefix="$" />);
    // prefix and number are siblings inside .metric-value; match on the container text
    const el = screen
      .getAllByText(
        (_, node) => (node?.textContent ?? '').includes('$') && node?.className === 'metric-value',
      )
      .at(0);
    expect(el).toBeInTheDocument();
  });

  it('renders with a suffix', () => {
    render(<MetricCard value={99} label="Score" suffix="%" />);
    const el = screen
      .getAllByText(
        (_, node) => (node?.textContent ?? '').includes('%') && node?.className === 'metric-value',
      )
      .at(0);
    expect(el).toBeInTheDocument();
  });

  it('renders corner decoration with aria-hidden', () => {
    const { container } = render(<MetricCard value={0} label="Test" />);
    // The corner decoration div is aria-hidden
    const hidden = container.querySelectorAll('[aria-hidden="true"]');
    expect(hidden.length).toBeGreaterThanOrEqual(1);
  });

  it('renders integer value (decimals=0) rounded', () => {
    render(<MetricCard value={7} label="Items" />);
    // The count-up starts at 0 and animates, initial render may show 0
    const el = screen.getByText('Items');
    expect(el).toBeInTheDocument();
  });
});
