import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Header } from './header.js';

describe('Header', () => {
  it('renders the logo text', () => {
    render(<Header />);
    expect(screen.getByText('review-agent')).toBeInTheDocument();
  });

  it('renders the date stamp', () => {
    render(<Header />);
    const stamp = screen.getByRole('img', { name: 'Current date' });
    expect(stamp).toBeInTheDocument();
    expect(stamp.textContent).toMatch(/WAVE 17/);
  });

  it('renders the theme toggle button', () => {
    render(<Header />);
    const btn = screen.getByRole('button', { name: /Switch to/ });
    expect(btn).toBeInTheDocument();
    // label switches between modes
    expect(btn.getAttribute('aria-label')).toMatch(/Switch to/);
  });

  it('toggles theme label when button is clicked', () => {
    render(<Header />);
    const btn = screen.getByRole('button', { name: /Switch to/ });
    const initialLabel = btn.getAttribute('aria-label') ?? '';
    fireEvent.click(btn);
    const newLabel = btn.getAttribute('aria-label') ?? '';
    // After click the label should reference the opposite mode
    expect(newLabel).not.toBe(initialLabel);
  });

  it('shows [DARK] or [LIGHT] toggle text', () => {
    render(<Header />);
    const btn = screen.getByRole('button', { name: /Switch to/ });
    expect(btn.textContent).toMatch(/\[(DARK|LIGHT)\]/);
  });

  it('renders the language toggle button', () => {
    render(<Header />);
    const langBtn = screen.getByRole('button', { name: /Switch language/i });
    expect(langBtn).toBeInTheDocument();
    // Should show [JA] or [EN]
    expect(langBtn.textContent).toMatch(/\[(JA|EN)\]/);
  });

  it('toggles language when language button is clicked', () => {
    render(<Header />);
    const langBtn = screen.getByRole('button', { name: /Switch language/i });
    const initialText = langBtn.textContent ?? '';
    fireEvent.click(langBtn);
    const newText = langBtn.textContent ?? '';
    expect(newText).not.toBe(initialText);
  });
});
