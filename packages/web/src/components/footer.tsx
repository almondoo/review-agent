import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Hairline } from './hairline.js';

export function Footer() {
  const { t } = useTranslation();

  return (
    <footer
      style={{
        backgroundColor: 'var(--bg)',
        borderTop: '1px solid var(--hairline)',
        padding: '1rem 2rem',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexWrap: 'wrap',
        gap: '0.75rem',
      }}
    >
      {/* Left: product mono-label */}
      <span
        className="label-mono"
        style={{
          color: 'var(--graphite)',
          fontSize: '0.5625rem',
          letterSpacing: '0.12em',
          opacity: 0.6,
        }}
      >
        {t('footer.productLabel')}
      </span>

      <Hairline vertical style={{ height: '16px' }} />

      {/* Right: nav link(s) */}
      <nav aria-label={t('footer.navAriaLabel')}>
        <Link
          to="/how-it-works"
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: '0.625rem',
            fontWeight: 600,
            letterSpacing: '0.1em',
            textTransform: 'uppercase',
            color: 'var(--graphite)',
            textDecoration: 'none',
            padding: '0.25rem 0',
            borderBottom: '1px solid transparent',
            transition: 'color var(--transition-fast), border-color var(--transition-fast)',
          }}
        >
          {t('footer.howItWorks')}
        </Link>
      </nav>
    </footer>
  );
}
