import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation } from 'react-router-dom';
import { useIntegrations } from '../api/client.js';
import type { CodeCommitIntegration, GithubIntegration, LlmIntegration } from '../api/types.js';
import { Hairline } from '../components/hairline.js';
import { StaggerContainer, StaggerItem } from '../components/page-transition.js';
import { SectionHeading } from '../components/section-heading.js';
import { StatusBadge } from '../components/status-badge.js';

const KNOWN_SETUP_ERRORS = [
  'validation_error',
  'missing_state_cookie',
  'state_mismatch',
  'setup_cancelled',
  'pending_admin_approval',
  'setup_failed',
] as const;
type SetupError = (typeof KNOWN_SETUP_ERRORS)[number];

type IntegrationCardProps = {
  title: string;
  tag: string;
  configured: boolean;
  children: React.ReactNode;
};

function IntegrationCard({ title, tag, configured, children }: IntegrationCardProps) {
  return (
    <div
      style={{
        border: '1px solid var(--hairline)',
        borderTop: `3px solid ${configured ? 'var(--moss)' : 'var(--graphite)'}`,
        padding: '1.5rem',
        borderRadius: 'var(--radius)',
        position: 'relative',
      }}
    >
      {/* Corner stamp */}
      <div
        aria-hidden="true"
        style={{
          position: 'absolute',
          top: '1rem',
          right: '1rem',
        }}
      >
        <StatusBadge status={configured ? 'configured' : 'unconfigured'} />
      </div>

      <div className="label-mono" style={{ color: 'var(--graphite)', marginBottom: '0.5rem' }}>
        {tag}
      </div>
      <h3
        style={{
          fontFamily: 'var(--font-display)',
          fontSize: '1.75rem',
          fontWeight: 700,
          letterSpacing: '-0.03em',
          marginBottom: '1rem',
          fontVariationSettings: "'opsz' 48, 'SOFT' 60",
        }}
      >
        {title}
      </h3>
      <Hairline style={{ marginBottom: '1rem' }} />
      <dl
        style={{
          display: 'grid',
          gridTemplateColumns: 'auto 1fr',
          gap: '0.375rem 1rem',
        }}
      >
        {children}
      </dl>
    </div>
  );
}

type FieldProps = {
  label: string;
  value: string;
};

function Field({ label, value }: FieldProps) {
  return (
    <>
      <dt className="label-mono" style={{ color: 'var(--graphite)', alignSelf: 'baseline' }}>
        {label}
      </dt>
      <dd
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: '0.8125rem',
          color: 'var(--fg)',
        }}
      >
        {value}
      </dd>
    </>
  );
}

function GithubCard({ data }: { data: GithubIntegration }) {
  const { t } = useTranslation();
  return (
    <IntegrationCard title="GitHub App" tag="platform / github" configured={data.configured}>
      <Field label={t('pages.integrations.fieldAppId')} value={data.appId ?? '—'} />
      <Field
        label={t('pages.integrations.fieldInstallations')}
        value={String(data.installationCount)}
      />
      {data.appSlug !== null && (
        <dt style={{ gridColumn: '1 / -1', marginTop: '0.75rem' }}>
          <button
            type="button"
            onClick={() => {
              window.location.assign('/github/install-redirect');
            }}
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: '0.6875rem',
              fontWeight: 700,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              color: 'var(--fg)',
              background: 'none',
              border: '1px solid var(--hairline)',
              borderRadius: 'var(--radius)',
              padding: '0.375rem 0.75rem',
              cursor: 'pointer',
            }}
          >
            {t('pages.integrations.connectGithub')}
          </button>
        </dt>
      )}
    </IntegrationCard>
  );
}

function CodeCommitCard({ data }: { data: CodeCommitIntegration }) {
  const { t } = useTranslation();
  return (
    <IntegrationCard
      title="AWS CodeCommit"
      tag="platform / codecommit"
      configured={data.configured}
    >
      <Field label={t('pages.integrations.fieldRegion')} value={data.region ?? '—'} />
    </IntegrationCard>
  );
}

function LlmCard({ data }: { data: LlmIntegration }) {
  const { t } = useTranslation();
  return (
    <IntegrationCard title="LLM Provider" tag="ai / model" configured={data.configured}>
      <Field label={t('pages.integrations.fieldProvider')} value={data.provider ?? '—'} />
      <Field label={t('pages.integrations.fieldModel')} value={data.model ?? '—'} />
    </IntegrationCard>
  );
}

function getSetupError(search: string): SetupError | null {
  const raw = new URLSearchParams(search).get('error');
  if (raw !== null && (KNOWN_SETUP_ERRORS as ReadonlyArray<string>).includes(raw)) {
    return raw as SetupError;
  }
  return null;
}

function errorKey(err: SetupError): string {
  if (err === 'setup_cancelled') return 'pages.integrations.errorSetupCancelled';
  if (err === 'pending_admin_approval') return 'pages.integrations.errorPendingAdminApproval';
  if (err === 'validation_error') return 'pages.integrations.errorValidationError';
  if (err === 'missing_state_cookie') return 'pages.integrations.errorMissingStateCookie';
  if (err === 'state_mismatch') return 'pages.integrations.errorStateMismatch';
  return 'pages.integrations.errorSetupFailed';
}

export function IntegrationsPage() {
  const { t } = useTranslation();
  const { data, isLoading, error } = useIntegrations();
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
          title={t('pages.integrations.title')}
          subtitle={t('pages.integrations.subtitle')}
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

      {isLoading && (
        <StaggerItem>
          <div className="label-mono" style={{ color: 'var(--graphite)' }}>
            {t('common.loading')}
          </div>
        </StaggerItem>
      )}

      {error && (
        <StaggerItem>
          <div className="label-mono" style={{ color: 'var(--rust)' }}>
            {t('pages.integrations.loadingError')}
          </div>
        </StaggerItem>
      )}

      {data && (
        <StaggerItem>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
              gap: '1.5rem',
            }}
          >
            <GithubCard data={data.github} />
            <CodeCommitCard data={data.codecommit} />
            <LlmCard data={data.llm} />
          </div>
        </StaggerItem>
      )}

      <StaggerItem>
        <div style={{ marginTop: '1.5rem' }}>
          <Link
            to="/integrations/keys"
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
            {t('pages.byokKeys.manageKeysLink')}
          </Link>
        </div>
      </StaggerItem>
    </StaggerContainer>
  );
}
