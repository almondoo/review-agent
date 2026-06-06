type ErrorStateProps = {
  message: string;
  onRetry?: () => void;
  retryLabel?: string;
};

export function ErrorState({ message, onRetry, retryLabel = '[RETRY]' }: ErrorStateProps) {
  return (
    <div style={{ padding: '2rem 0' }}>
      <p className="label-mono" style={{ color: 'var(--rust)', marginBottom: '0.75rem' }}>
        {message}
      </p>
      {onRetry !== undefined && (
        <button
          type="button"
          onClick={onRetry}
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: '0.6875rem',
            fontWeight: 600,
            letterSpacing: '0.08em',
            color: 'var(--rust)',
            border: '1px solid var(--rust)',
            padding: '0.25rem 0.625rem',
            borderRadius: 'var(--radius)',
            background: 'transparent',
            cursor: 'pointer',
          }}
        >
          {retryLabel}
        </button>
      )}
    </div>
  );
}
