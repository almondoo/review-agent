import { act, render, screen } from '@testing-library/react';
import i18n from 'i18next';
import type React from 'react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UnsavedChangesDialog } from './unsaved-changes-dialog.js';

type Props = React.ComponentProps<typeof UnsavedChangesDialog>;

function renderDialog(overrides: Partial<Props> = {}) {
  const defaults: Props = {
    isBlocked: true,
    confirm: vi.fn(),
    cancel: vi.fn(),
    ...overrides,
  };
  render(
    <I18nextProvider i18n={i18n}>
      <UnsavedChangesDialog {...defaults} />
    </I18nextProvider>,
  );
  return defaults;
}

describe('UnsavedChangesDialog', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('renders the dialog when isBlocked is true', () => {
    renderDialog({ isBlocked: true });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '[LEAVE]' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '[STAY]' })).toBeInTheDocument();
  });

  it('renders nothing when isBlocked is false', () => {
    renderDialog({ isBlocked: false });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('calls confirm when the confirm button is clicked', async () => {
    const props = renderDialog({ isBlocked: true });
    const leaveBtn = screen.getByRole('button', { name: '[LEAVE]' });
    await act(async () => {
      leaveBtn.click();
    });
    expect(props.confirm).toHaveBeenCalledTimes(1);
    expect(props.cancel).not.toHaveBeenCalled();
  });

  it('calls cancel when the cancel button is clicked', async () => {
    const props = renderDialog({ isBlocked: true });
    const stayBtn = screen.getByRole('button', { name: '[STAY]' });
    await act(async () => {
      stayBtn.click();
    });
    expect(props.cancel).toHaveBeenCalledTimes(1);
    expect(props.confirm).not.toHaveBeenCalled();
  });
});
