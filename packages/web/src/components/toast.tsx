import { useEffect, useState } from 'react';

type ToastMessage = {
  id: number;
  text: string;
  type: 'success' | 'error';
};

type ToastProps = {
  messages: ToastMessage[];
  onDismiss: (id: number) => void;
};

export function ToastContainer({ messages, onDismiss }: ToastProps) {
  return (
    <div
      aria-live="polite"
      aria-atomic="false"
      style={{
        position: 'fixed',
        top: '1rem',
        right: '1rem',
        zIndex: 10000,
        display: 'flex',
        flexDirection: 'column',
        gap: '0.5rem',
        pointerEvents: 'none',
      }}
    >
      {messages.map((m) => (
        <ToastItem key={m.id} message={m} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

function ToastItem({
  message,
  onDismiss,
}: {
  message: ToastMessage;
  onDismiss: (id: number) => void;
}) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const show = setTimeout(() => setVisible(true), 10);
    const hide = setTimeout(() => {
      setVisible(false);
      setTimeout(() => onDismiss(message.id), 300);
    }, 3000);
    return () => {
      clearTimeout(show);
      clearTimeout(hide);
    };
  }, [message.id, onDismiss]);

  return (
    <output
      style={{
        display: 'block',
        fontFamily: 'var(--font-mono)',
        fontSize: '0.75rem',
        fontWeight: 600,
        letterSpacing: '0.06em',
        color: message.type === 'error' ? 'var(--rust)' : 'var(--moss)',
        backgroundColor: 'var(--bg)',
        border: `1px solid ${message.type === 'error' ? 'var(--rust)' : 'var(--moss)'}`,
        padding: '0.5rem 1rem',
        borderRadius: 'var(--radius)',
        pointerEvents: 'auto',
        opacity: visible ? 1 : 0,
        transform: visible ? 'translateY(0)' : 'translateY(-8px)',
        transition: 'opacity 200ms ease, transform 200ms ease',
        whiteSpace: 'nowrap',
      }}
    >
      {message.text}
    </output>
  );
}

type UseToastReturn = {
  messages: ToastMessage[];
  toast: (text: string, type?: 'success' | 'error') => void;
  dismiss: (id: number) => void;
};

let counter = 0;

export function useToast(): UseToastReturn {
  const [messages, setMessages] = useState<ToastMessage[]>([]);

  function toast(text: string, type: 'success' | 'error' = 'success') {
    const id = ++counter;
    setMessages((prev) => [...prev, { id, text, type }]);
  }

  function dismiss(id: number) {
    setMessages((prev) => prev.filter((m) => m.id !== id));
  }

  return { messages, toast, dismiss };
}
