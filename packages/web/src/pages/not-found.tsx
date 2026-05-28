import { Link } from 'react-router-dom';

export function NotFoundPage() {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-start',
        justifyContent: 'center',
        padding: '4rem 0',
        gap: '1rem',
      }}
    >
      <span className="label-mono" style={{ color: 'var(--graphite)' }}>
        404 / not-found
      </span>
      <h1 className="display" style={{ color: 'var(--ink)', marginBottom: '0.5rem' }}>
        Not here.
      </h1>
      <p className="body-sm" style={{ color: 'var(--graphite)', maxWidth: '40ch' }}>
        The page you requested does not exist or has been moved.
      </p>
      <Link
        to="/"
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: '0.6875rem',
          fontWeight: 600,
          letterSpacing: '0.08em',
          color: 'var(--rust)',
          padding: '0.375rem 0',
          textTransform: 'uppercase',
        }}
      >
        [← Return to Overview]
      </Link>
    </div>
  );
}
