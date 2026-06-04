import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation } from 'react-router-dom';
import { StaggerContainer, StaggerItem } from '../components/page-transition.js';
import { SectionHeading } from '../components/section-heading.js';

const KNOWN_SETUP_ERRORS = ['pending_admin_approval'] as const;
type SetupError = (typeof KNOWN_SETUP_ERRORS)[number];

function getSetupError(search: string): SetupError | null {
  const raw = new URLSearchParams(search).get('error');
  if (raw !== null && (KNOWN_SETUP_ERRORS as ReadonlyArray<string>).includes(raw)) {
    return raw as SetupError;
  }
  return null;
}

function errorKey(err: SetupError): string {
  if (err === 'pending_admin_approval') return 'pages.integrations.errorPendingAdminApproval';
  return 'pages.integrations.errorSetupFailed';
}

export function GithubSetupPage() {
  const { t } = useTranslation();
  const { search } = useLocation();
  const initialSetupError = getSetupError(search);
  const [setupError, setSetupError] = useState<SetupError | null>(initialSetupError);

  function dismissError() {
    setSetupError(null);
    const url = new URL(window.location.href);
    url.searchParams.delete('error');
    window.history.replaceState(null, '', url.toString());
  }

  return (
    <StaggerContainer>
      <StaggerItem>
        <SectionHeading
          title={t('pages.githubSetup.title')}
          subtitle={t('pages.githubSetup.subtitle')}
        />
      </StaggerItem>

      {setupError !== null && (
        <StaggerItem>
          <div
            role="alert"
            style={{
              display: 'flex',
              alignItems: 'baseline',
              justifyContent: 'space-between',
              gap: '0.75rem',
              padding: '0.75rem 1rem',
              border: '1px solid var(--rust)',
              borderRadius: 'var(--radius)',
              fontFamily: 'var(--font-mono)',
              fontSize: '0.75rem',
              color: 'var(--rust)',
              marginBottom: '0.5rem',
            }}
          >
            <span>{t(errorKey(setupError))}</span>
            <button
              type="button"
              aria-label={t('pages.integrations.errorDismiss')}
              onClick={dismissError}
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: '0.75rem',
                fontWeight: 700,
                color: 'var(--rust)',
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                padding: 0,
                flexShrink: 0,
              }}
            >
              {t('pages.integrations.errorDismiss')}
            </button>
          </div>
        </StaggerItem>
      )}

      <StaggerItem>
        <p className="label-mono" style={{ color: 'var(--graphite)', marginBottom: '1.5rem' }}>
          {t('pages.githubSetup.description')}
        </p>
      </StaggerItem>

      <StaggerItem>
        <Link
          to="/integrations"
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: '0.6875rem',
            fontWeight: 700,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            color: 'var(--fg)',
            textDecoration: 'none',
          }}
        >
          {t('pages.githubSetup.backLink')}
        </Link>
      </StaggerItem>
    </StaggerContainer>
  );
}
