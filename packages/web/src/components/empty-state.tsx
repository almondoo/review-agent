import { Link } from 'react-router-dom';

type EmptyStateProps = {
  message: string;
  ctaLabel?: string;
  ctaHref?: string;
};

export function EmptyState({ message, ctaLabel, ctaHref }: EmptyStateProps) {
  return (
    <div style={{ padding: '2rem 0' }}>
      <p className="label-mono" style={{ color: 'var(--graphite)', marginBottom: '0.75rem' }}>
        {message}
      </p>
      {ctaLabel !== undefined && ctaHref !== undefined && (
        <Link
          to={ctaHref}
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: '0.6875rem',
            fontWeight: 700,
            letterSpacing: '0.08em',
            color: 'var(--rust)',
            border: '1px solid var(--rust)',
            padding: '0.25rem 0.625rem',
            borderRadius: 'var(--radius)',
            display: 'inline-block',
            textDecoration: 'none',
          }}
        >
          {ctaLabel}
        </Link>
      )}
    </div>
  );
}
