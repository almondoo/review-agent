import { useOverview } from '../api/client.js';
import { MetricCard } from '../components/metric-card.js';
import { StaggerContainer, StaggerItem } from '../components/page-transition.js';
import { SectionHeading } from '../components/section-heading.js';

export function OverviewPage() {
  const { data, isLoading, error } = useOverview();

  if (isLoading) {
    return (
      <div className="label-mono" style={{ color: 'var(--graphite)', padding: '2rem 0' }}>
        [LOADING...]
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="label-mono" style={{ color: 'var(--rust)', padding: '2rem 0' }}>
        [ERROR] Failed to load overview metrics.
      </div>
    );
  }

  return (
    <StaggerContainer>
      <StaggerItem>
        <SectionHeading title="Overview" subtitle="Dashboard — current state" />
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
              { value: data.totalRepos, label: 'Total Repos', prefix: '', suffix: '' },
              { value: data.reviewsMonth, label: 'Reviews / Month', prefix: '', suffix: '' },
              { value: data.queueDepth, label: 'Queue Depth', prefix: '', suffix: '' },
              {
                value: data.costMtd,
                label: 'Cost MTD (USD)',
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
              system / status
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
              {data.queueDepth === 0 ? 'Idle.' : 'Active.'}
            </p>
            <p className="body-sm" style={{ color: 'var(--graphite)', maxWidth: '40ch' }}>
              {data.queueDepth === 0
                ? 'No pending reviews in queue. Agent is standing by.'
                : `${data.queueDepth} review${data.queueDepth === 1 ? '' : 's'} currently queued for processing.`}
            </p>
          </div>
        </div>
      </StaggerItem>
    </StaggerContainer>
  );
}
