import { useTranslation } from 'react-i18next';
import { useOverview } from '../api/client.js';
import { MetricCard } from '../components/metric-card.js';
import { StaggerContainer, StaggerItem } from '../components/page-transition.js';
import { SectionHeading } from '../components/section-heading.js';

export function OverviewPage() {
  const { t } = useTranslation();
  const { data, isLoading, error } = useOverview();

  if (isLoading) {
    return (
      <div className="label-mono" style={{ color: 'var(--graphite)', padding: '2rem 0' }}>
        {t('common.loading')}
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="label-mono" style={{ color: 'var(--rust)', padding: '2rem 0' }}>
        {t('pages.overview.loadingError')}
      </div>
    );
  }

  return (
    <StaggerContainer>
      <StaggerItem>
        <SectionHeading title={t('pages.overview.title')} subtitle={t('pages.overview.subtitle')} />
      </StaggerItem>

      {/* Metrics grid */}
      <StaggerItem>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
            gap: '1px',
            backgroundColor: 'var(--hairline)',
            border: '1px solid var(--hairline)',
            marginBottom: '3rem',
          }}
        >
          {(
            [
              {
                value: data.totalRepos,
                label: t('pages.overview.totalRepos'),
                prefix: '',
                suffix: '',
              },
              {
                value: data.reviewsMonth,
                label: t('pages.overview.reviewsMonth'),
                prefix: '',
                suffix: '',
              },
              {
                value: data.queueDepth,
                label: t('pages.overview.queueDepth'),
                prefix: '',
                suffix: '',
              },
              {
                value: data.costMtd,
                label: t('pages.overview.costMtd'),
                prefix: '$',
                suffix: '',
                decimals: 2,
              },
            ] satisfies Array<{
              value: number;
              label: string;
              prefix: string;
              suffix: string;
              decimals?: number;
            }>
          ).map((m) => (
            <div key={m.label} style={{ backgroundColor: 'var(--bg)' }}>
              <MetricCard
                value={m.value}
                label={m.label}
                prefix={m.prefix}
                suffix={m.suffix}
                {...(m.decimals !== undefined ? { decimals: m.decimals } : {})}
              />
            </div>
          ))}
        </div>
      </StaggerItem>

      {/* Decorative editorial block */}
      <StaggerItem>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 2fr',
            gap: '2rem',
            alignItems: 'start',
          }}
        >
          <div>
            <div
              style={{
                writingMode: 'vertical-rl',
                textOrientation: 'mixed',
                fontFamily: 'var(--font-mono)',
                fontSize: '0.5625rem',
                letterSpacing: '0.15em',
                textTransform: 'uppercase',
                color: 'var(--graphite)',
                opacity: 0.5,
                marginBottom: '1rem',
              }}
            >
              {t('status.systemStatus')}
            </div>
          </div>

          <div style={{ borderLeft: '1px solid var(--hairline)', paddingLeft: '2rem' }}>
            <p
              className="display"
              style={{
                fontSize: 'clamp(48px, 6vw, 96px)',
                color: 'var(--ink)',
                lineHeight: 0.95,
                marginBottom: '1rem',
              }}
            >
              {data.queueDepth === 0 ? t('status.idle') : t('status.active')}
            </p>
            <p className="body-sm" style={{ color: 'var(--graphite)', maxWidth: '40ch' }}>
              {data.queueDepth === 0
                ? t('status.idleDescription')
                : t(
                    data.queueDepth === 1
                      ? 'status.activeDescription'
                      : 'status.activeDescriptionPlural',
                    { count: data.queueDepth },
                  )}
            </p>
          </div>
        </div>
      </StaggerItem>
    </StaggerContainer>
  );
}
