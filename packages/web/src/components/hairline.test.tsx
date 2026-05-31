import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Hairline } from './hairline.js';

describe('Hairline', () => {
  it('renders a horizontal hairline by default', () => {
    const { container } = render(<Hairline />);
    const el = container.firstElementChild as HTMLElement;
    expect(el).toBeInTheDocument();
    expect(el.style.height).toBe('1px');
    expect(el.style.width).toBe('100%');
  });

  it('renders a vertical hairline when vertical=true', () => {
    const { container } = render(<Hairline vertical />);
    const el = container.firstElementChild as HTMLElement;
    expect(el.style.width).toBe('1px');
    expect(el.style.height).toBe('100%');
  });

  it('merges custom style props', () => {
    const { container } = render(<Hairline style={{ marginBottom: '1rem' }} />);
    const el = container.firstElementChild as HTMLElement;
    expect(el.style.marginBottom).toBe('1rem');
  });

  it('has aria-hidden', () => {
    const { container } = render(<Hairline />);
    const el = container.firstElementChild as HTMLElement;
    expect(el).toHaveAttribute('aria-hidden', 'true');
  });
});
