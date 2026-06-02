// Convention: ALL delete actions and navigation-guard confirmations (issue #119)
// in this app MUST go through ConfirmDialog — never use window.confirm() or
// bespoke inline confirm UI. This keeps focus management, accessibility, and
// visual style consistent across every destructive operation.

import { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';

export type ConfirmDialogTone = 'danger' | 'default';

export type ConfirmDialogProps = {
  isOpen: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  tone?: ConfirmDialogTone;
  onConfirm: () => void;
  onCancel: () => void;
};

export function ConfirmDialog({
  isOpen,
  title,
  message,
  confirmLabel,
  cancelLabel,
  tone = 'default',
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const titleId = useId();
  const messageId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const confirmBtnRef = useRef<HTMLButtonElement>(null);

  // Save focus target before opening; restore it on close.
  useEffect(() => {
    if (isOpen) {
      previousFocusRef.current = document.activeElement as HTMLElement;
      // Move focus into dialog on next tick so the portal is mounted.
      const id = setTimeout(() => {
        confirmBtnRef.current?.focus();
      }, 0);
      return () => clearTimeout(id);
    } else {
      previousFocusRef.current?.focus();
      previousFocusRef.current = null;
    }
  }, [isOpen]);

  // Close on Escape, trap focus within dialog.
  useEffect(() => {
    if (!isOpen) return;

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
        return;
      }

      if (e.key !== 'Tab') return;

      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (!focusable || focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    }

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onCancel]);

  if (!isOpen) return null;

  const isDanger = tone === 'danger';

  function handleBackdropClick(e: React.MouseEvent<HTMLDivElement>) {
    if (e.target === e.currentTarget) {
      onCancel();
    }
  }

  return createPortal(
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop div is a visual dismiss target; real keyboard handling (Esc) is on the document listener; screen readers interact with the dialog element, not this wrapper
    <div
      role="presentation"
      onClick={handleBackdropClick}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'rgba(10, 9, 7, 0.55)',
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={messageId}
        style={{
          backgroundColor: 'var(--bg)',
          border: '1px solid var(--hairline)',
          borderRadius: 'var(--radius)',
          padding: '2rem',
          maxWidth: '420px',
          width: '100%',
          margin: '1rem',
          boxShadow: '0 8px 32px rgba(10, 9, 7, 0.2)',
        }}
      >
        <p
          id={titleId}
          style={{
            fontFamily: 'var(--font-display)',
            fontSize: '1.25rem',
            fontWeight: 700,
            letterSpacing: '-0.03em',
            color: 'var(--fg)',
            marginBottom: '0.75rem',
          }}
        >
          {title}
        </p>

        <p
          id={messageId}
          style={{
            fontFamily: 'var(--font-body)',
            fontSize: '0.875rem',
            color: 'var(--graphite)',
            lineHeight: 1.5,
            marginBottom: '1.75rem',
          }}
        >
          {message}
        </p>

        <div
          style={{
            display: 'flex',
            gap: '0.75rem',
            justifyContent: 'flex-end',
          }}
        >
          <button
            type="button"
            onClick={onCancel}
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: '0.6875rem',
              fontWeight: 600,
              letterSpacing: '0.08em',
              color: 'var(--graphite)',
              border: '1px solid var(--hairline)',
              padding: '0.375rem 0.75rem',
              borderRadius: 'var(--radius)',
              transition: 'all var(--transition-fast)',
              backgroundColor: 'transparent',
            }}
          >
            {cancelLabel}
          </button>

          <button
            ref={confirmBtnRef}
            type="button"
            onClick={onConfirm}
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: '0.6875rem',
              fontWeight: 600,
              letterSpacing: '0.08em',
              color: isDanger ? 'var(--rust)' : 'var(--fg)',
              border: `1px solid ${isDanger ? 'var(--rust)' : 'var(--hairline)'}`,
              padding: '0.375rem 0.75rem',
              borderRadius: 'var(--radius)',
              transition: 'all var(--transition-fast)',
              backgroundColor: 'transparent',
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
