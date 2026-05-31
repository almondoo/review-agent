import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToastContainer, useToast } from './toast.js';

// Helper component to exercise useToast
function ToastHarness() {
  const { messages, toast, dismiss } = useToast();
  return (
    <>
      <button type="button" onClick={() => toast('Saved!', 'success')}>
        success
      </button>
      <button type="button" onClick={() => toast('Error!', 'error')}>
        error
      </button>
      <button type="button" onClick={() => toast('Default')}>
        default
      </button>
      <ToastContainer messages={messages} onDismiss={dismiss} />
    </>
  );
}

describe('ToastContainer', () => {
  it('renders nothing when messages array is empty', () => {
    const { container } = render(<ToastContainer messages={[]} onDismiss={() => {}} />);
    // The live region container is present but has no toast items inside
    const liveRegion = container.querySelector('[aria-live]');
    expect(liveRegion).toBeInTheDocument();
    expect(liveRegion?.children).toHaveLength(0);
  });

  it('renders a success toast with moss color', () => {
    const msgs = [{ id: 1, text: 'Done!', type: 'success' as const }];
    render(<ToastContainer messages={msgs} onDismiss={() => {}} />);
    const output = screen.getByText('Done!');
    expect(output).toBeInTheDocument();
    expect(output).toHaveStyle({ color: 'var(--moss)' });
  });

  it('renders an error toast with rust color', () => {
    const msgs = [{ id: 2, text: 'Oops!', type: 'error' as const }];
    render(<ToastContainer messages={msgs} onDismiss={() => {}} />);
    const output = screen.getByText('Oops!');
    expect(output).toHaveStyle({ color: 'var(--rust)' });
  });

  it('renders multiple toasts', () => {
    const msgs = [
      { id: 1, text: 'First', type: 'success' as const },
      { id: 2, text: 'Second', type: 'error' as const },
    ];
    render(<ToastContainer messages={msgs} onDismiss={() => {}} />);
    expect(screen.getByText('First')).toBeInTheDocument();
    expect(screen.getByText('Second')).toBeInTheDocument();
  });

  it('has aria-live polite region', () => {
    const { container } = render(<ToastContainer messages={[]} onDismiss={() => {}} />);
    const region = container.querySelector('[aria-live="polite"]');
    expect(region).toBeInTheDocument();
  });
});

describe('useToast', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('adds a success message via toast()', async () => {
    render(<ToastHarness />);
    const btn = screen.getByRole('button', { name: 'success' });
    act(() => {
      btn.click();
    });
    expect(await screen.findByText('Saved!')).toBeInTheDocument();
  });

  it('adds an error message via toast()', async () => {
    render(<ToastHarness />);
    const btn = screen.getByRole('button', { name: 'error' });
    act(() => {
      btn.click();
    });
    expect(await screen.findByText('Error!')).toBeInTheDocument();
  });

  it('defaults type to success when omitted', async () => {
    render(<ToastHarness />);
    const btn = screen.getByRole('button', { name: 'default' });
    act(() => {
      btn.click();
    });
    const msg = await screen.findByText('Default');
    expect(msg).toHaveStyle({ color: 'var(--moss)' });
  });

  it('auto-dismisses after 3s + fade-out', () => {
    // Fake only timers (not Date) so React state updates via setTimeout work deterministically.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    render(<ToastHarness />);

    // Add the toast message
    act(() => {
      screen.getByRole('button', { name: 'success' }).click();
    });
    // Toast is rendered immediately (show timer at 10ms hasn't fired yet but message is in state)
    expect(screen.getByText('Saved!')).toBeInTheDocument();

    // Advance past show delay (10ms) + hide delay (3000ms) + fade-out + dismiss (300ms) = 3310ms
    act(() => {
      vi.advanceTimersByTime(3310);
    });
    // Toast should be dismissed from the messages array and removed from DOM
    expect(screen.queryByText('Saved!')).toBeNull();
  });
});
