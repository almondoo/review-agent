import { useTranslation } from 'react-i18next';
import { useIntegrations } from '../api/client.js';
import type { CodeCommitIntegration, GithubIntegration, LlmIntegration } from '../api/types.js';
import { Hairline } from '../components/hairline.js';
import { StaggerContainer, StaggerItem } from '../components/page-transition.js';
import { SectionHeading } from '../components/section-heading.js';
import { StatusBadge } from '../components/status-badge.js';

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

export function IntegrationsPage() {
  const { t } = useTranslation();
  const { data, isLoading, error } = useIntegrations();

  return (
    <StaggerContainer>
      <StaggerItem>
        <SectionHeading
          title={t('pages.integrations.title')}
          subtitle={t('pages.integrations.subtitle')}
        />
      </StaggerItem>

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
    </StaggerContainer>
  );
}
