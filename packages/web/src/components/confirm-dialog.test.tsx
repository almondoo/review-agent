import { act, fireEvent, render, screen, within } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfirmDialog } from './confirm-dialog.js';

type Props = Partial<React.ComponentProps<typeof ConfirmDialog>>;

function renderDialog(overrides: Props = {}) {
  const defaults = {
    isOpen: true,
    title: 'Are you sure?',
    message: 'This action cannot be undone.',
    confirmLabel: '[OK]',
    cancelLabel: '[CANCEL]',
    onConfirm: vi.fn(),
    onCancel: vi.fn(),
  };
  const props = { ...defaults, ...overrides };
  const result = render(<ConfirmDialog {...props} />);
  return { ...result, onConfirm: props.onConfirm, onCancel: props.onCancel };
}

describe('ConfirmDialog', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  // ── Rendering ──────────────────────────────────────────────────────────────

  it('renders nothing when isOpen is false', () => {
    const { container } = renderDialog({ isOpen: false });
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it('renders title, message, and labels from props', () => {
    renderDialog({
      title: 'Delete item',
      message: 'Permanently remove this item?',
      confirmLabel: '[DELETE]',
      cancelLabel: '[CANCEL]',
    });
    expect(screen.getByText('Delete item')).toBeInTheDocument();
    expect(screen.getByText('Permanently remove this item?')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '[DELETE]' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '[CANCEL]' })).toBeInTheDocument();
  });

  it('has role="dialog", aria-modal, aria-labelledby, aria-describedby', () => {
    renderDialog();
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');

    const labelledById = dialog.getAttribute('aria-labelledby');
    const describedById = dialog.getAttribute('aria-describedby');
    expect(labelledById).toBeTruthy();
    expect(describedById).toBeTruthy();

    const titleEl = document.getElementById(labelledById ?? '');
    expect(titleEl).toBeInTheDocument();
    expect(titleEl?.textContent).toBe('Are you sure?');

    const msgEl = document.getElementById(describedById ?? '');
    expect(msgEl).toBeInTheDocument();
    expect(msgEl?.textContent).toBe('This action cannot be undone.');
  });

  // ── tone='danger' ──────────────────────────────────────────────────────────

  it('applies rust color to confirm button when tone="danger"', () => {
    renderDialog({ tone: 'danger', confirmLabel: '[DELETE]' });
    const confirmBtn = screen.getByRole('button', { name: '[DELETE]' });
    expect(confirmBtn).toHaveStyle({ color: 'var(--rust)' });
  });

  it('does not apply rust color to confirm button when tone="default"', () => {
    renderDialog({ tone: 'default', confirmLabel: '[OK]' });
    const confirmBtn = screen.getByRole('button', { name: '[OK]' });
    expect(confirmBtn).toHaveStyle({ color: 'var(--fg)' });
  });

  it('does not apply rust color to confirm button when tone is omitted', () => {
    renderDialog({ confirmLabel: '[OK]' });
    const confirmBtn = screen.getByRole('button', { name: '[OK]' });
    expect(confirmBtn).toHaveStyle({ color: 'var(--fg)' });
  });

  // ── Callbacks ──────────────────────────────────────────────────────────────

  it('calls onConfirm when the confirm button is clicked', async () => {
    const { onConfirm, onCancel } = renderDialog();
    const confirmBtn = screen.getByRole('button', { name: '[OK]' });
    await act(async () => {
      confirmBtn.click();
    });
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('calls onCancel (and not onConfirm) when the cancel button is clicked', async () => {
    const { onConfirm, onCancel } = renderDialog();
    const cancelBtn = screen.getByRole('button', { name: '[CANCEL]' });
    await act(async () => {
      cancelBtn.click();
    });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  // ── Escape key ─────────────────────────────────────────────────────────────

  it('calls onCancel when Escape is pressed', async () => {
    const { onConfirm, onCancel } = renderDialog();
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('does NOT call onCancel when Escape is pressed and dialog is closed', async () => {
    const { onCancel } = renderDialog({ isOpen: false });
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(onCancel).not.toHaveBeenCalled();
  });

  // ── Backdrop click ─────────────────────────────────────────────────────────

  it('calls onCancel when the backdrop overlay is clicked', async () => {
    const { onCancel } = renderDialog();
    const dialog = screen.getByRole('dialog');
    const backdrop = dialog.parentElement;
    expect(backdrop).toBeInTheDocument();

    await act(async () => {
      // Simulate a click where the target IS the backdrop (currentTarget === target).
      // We use a custom event that fires on the backdrop itself.
      backdrop?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('does NOT call onCancel when the dialog box itself is clicked', async () => {
    const { onCancel } = renderDialog();
    const dialog = screen.getByRole('dialog');

    await act(async () => {
      dialog.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    // Clicking inside the dialog box should bubble up to backdrop handler,
    // but e.target !== e.currentTarget so it should NOT cancel.
    // However because the event bubbles, the backdrop handler fires too with e.target === dialog.
    // The handler checks e.target === e.currentTarget (backdrop div), which is false, so no cancel.
    expect(onCancel).not.toHaveBeenCalled();
  });

  // ── Focus management ────────────────────────────────────────────────────────

  it('focus returns to the previously focused element when dialog closes', async () => {
    function Harness() {
      const [open, setOpen] = React.useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)} data-testid="trigger">
            Open
          </button>
          <ConfirmDialog
            isOpen={open}
            title="Confirm"
            message="Sure?"
            confirmLabel="[YES]"
            cancelLabel="[NO]"
            onConfirm={() => setOpen(false)}
            onCancel={() => setOpen(false)}
          />
        </>
      );
    }

    render(<Harness />);

    const openBtn = screen.getByTestId('trigger');
    openBtn.focus();
    expect(document.activeElement).toBe(openBtn);

    await act(async () => {
      openBtn.click();
    });

    const confirmBtn = screen.getByRole('button', { name: '[YES]' });
    expect(confirmBtn).toBeInTheDocument();

    await act(async () => {
      confirmBtn.click();
    });

    expect(document.activeElement).toBe(openBtn);
  });

  // ── Focus trap ─────────────────────────────────────────────────────────────

  it('traps focus within the dialog: Tab from last focusable wraps to first', async () => {
    renderDialog();
    const dialog = screen.getByRole('dialog');
    const buttons = within(dialog).getAllByRole('button');
    expect(buttons.length).toBeGreaterThanOrEqual(2);

    const firstBtn = buttons[0];
    const lastBtn = buttons[buttons.length - 1];

    // Spy on focus to verify it is called on the first button
    const focusSpy = vi.spyOn(firstBtn as HTMLElement, 'focus');

    lastBtn?.focus();

    await act(async () => {
      fireEvent.keyDown(document, { key: 'Tab', shiftKey: false, bubbles: true });
    });

    // The focus trap handler should have called focus() on the first button
    expect(focusSpy).toHaveBeenCalled();
    focusSpy.mockRestore();
  });

  it('traps focus within the dialog: Shift+Tab from first focusable wraps to last', async () => {
    renderDialog();
    const dialog = screen.getByRole('dialog');
    const buttons = within(dialog).getAllByRole('button');
    expect(buttons.length).toBeGreaterThanOrEqual(2);

    const firstBtn = buttons[0];
    firstBtn?.focus();
    expect(document.activeElement).toBe(firstBtn);

    await act(async () => {
      fireEvent.keyDown(document, { key: 'Tab', shiftKey: true, bubbles: true });
    });

    expect(document.activeElement).toBe(buttons[buttons.length - 1]);
  });
});
