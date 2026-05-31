import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { GrainOverlay } from './grain-overlay.js';

describe('GrainOverlay', () => {
  it('renders a decorative div with aria-hidden', () => {
    const { container } = render(<GrainOverlay />);
    const el = container.firstElementChild as HTMLElement;
    expect(el).toBeInTheDocument();
    expect(el).toHaveAttribute('aria-hidden', 'true');
  });

  it('has pointer-events none (non-interactive)', () => {
    const { container } = render(<GrainOverlay />);
    const el = container.firstElementChild as HTMLElement;
    expect(el.style.pointerEvents).toBe('none');
  });
});
