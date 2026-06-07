import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useQualityMetrics } from '../api/client.js';
import type { MetricsSince, RepoQualitySnapshot } from '../api/types.js';
import { ErrorState } from '../components/error-state.js';
import { StaggerContainer, StaggerItem } from '../components/page-transition.js';
import { SectionHeading } from '../components/section-heading.js';
import { useAuth } from '../contexts/auth-context.js';

// --- Helpers ---

function formatRate(value: number | null, na: string): string {
  if (value === null) return na;
  return `${Math.round(value * 100)}%`;
}

function formatLatency(value: number | null, na: string): string {
  if (value === null) return na;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}s`;
  return `${value}ms`;
}

// --- Tooltip component ---

type TooltipProps = {
  text: string;
  children: React.ReactNode;
};

/** Renders children with a native title tooltip on hover. */
function Tooltip({ text, children }: TooltipProps) {
  return (
    <span style={{ position: 'relative', display: 'inline-block', cursor: 'help' }} title={text}>
      {children}
    </span>
  );
}

// --- Installation selector ---

type InstallationSelectorProps = {
  installationIds: string[];
  selected: string | null;
  onChange: (id: string) => void;
  label: string;
  placeholder: string;
};

function InstallationSelector({
  installationIds,
  selected,
  onChange,
  label,
  placeholder,
}: InstallationSelectorProps) {
  const uid = useId();
  if (installationIds.length === 0) return null;
  if (installationIds.length === 1) return null;

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
      <label
        htmlFor={uid}
        className="label-mono"
        style={{ color: 'var(--graphite)', whiteSpace: 'nowrap' }}
      >
        {label}
      </label>
      <select
        id={uid}
        value={selected ?? ''}
        onChange={(e) => onChange(e.target.value)}
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: '0.6875rem',
          fontWeight: 600,
          letterSpacing: '0.08em',
          color: 'var(--fg)',
          backgroundColor: 'var(--bg)',
          border: '1px solid var(--hairline)',
          borderRadius: 'var(--radius)',
          padding: '0.25rem 0.5rem',
          cursor: 'pointer',
        }}
        aria-label={label}
      >
        {selected === null && (
          <option value="" disabled>
            {placeholder}
          </option>
        )}
        {installationIds.map((id) => (
          <option key={id} value={id}>
            #{id}
          </option>
        ))}
      </select>
    </div>
  );
}

// --- Period selector ---

const PERIOD_OPTIONS: MetricsSince[] = ['24h', '7d', '30d'];

type PeriodSelectorProps = {
  value: MetricsSince;
  onChange: (v: MetricsSince) => void;
  label: string;
  labels: Record<MetricsSince, string>;
};

function PeriodSelector({ value, onChange, label, labels }: PeriodSelectorProps) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
      <span className="label-mono" style={{ color: 'var(--graphite)', whiteSpace: 'nowrap' }}>
        {label}
      </span>
      <div style={{ display: 'flex', gap: '0.25rem' }}>
        {PERIOD_OPTIONS.map((opt) => (
          <button
            key={opt}
            type="button"
            onClick={() => onChange(opt)}
            aria-pressed={value === opt}
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: '0.6875rem',
              fontWeight: value === opt ? 700 : 400,
              letterSpacing: '0.08em',
              color: value === opt ? 'var(--rust)' : 'var(--fg)',
              backgroundColor: 'transparent',
              border: `1px solid ${value === opt ? 'var(--rust)' : 'var(--hairline)'}`,
              borderRadius: 'var(--radius)',
              padding: '0.25rem 0.5rem',
              cursor: 'pointer',
            }}
          >
            {labels[opt]}
          </button>
        ))}
      </div>
    </div>
  );
}

// --- N/A-capable metric card ---

type NaMetricCardProps = {
  display: string;
  label: string;
  tooltip: string;
};

function NaMetricCard({ display, label, tooltip }: NaMetricCardProps) {
  return (
    <div
      style={{
        padding: '1.5rem',
        borderTop: '2px solid var(--ink)',
        position: 'relative',
      }}
    >
      {/* Corner decoration */}
      <div
        aria-hidden="true"
        style={{
          position: 'absolute',
          top: -2,
          right: 0,
          width: 24,
          height: 2,
          backgroundColor: 'var(--rust)',
        }}
      />
      <Tooltip text={tooltip}>
        <div className="metric-value">{display}</div>
      </Tooltip>
      <div className="metric-label" style={{ marginTop: '0.5rem' }}>
        <Tooltip text={tooltip}>{label}</Tooltip>
      </div>
    </div>
  );
}

// --- Overall metrics panel ---

type OverallPanelProps = {
  data: {
    reviewCount: number;
    acceptanceRate: number | null;
    falsePositiveRate: number | null;
    coverageRate: number | null;
    latencyP50Ms: number | null;
    latencyP95Ms: number | null;
  };
  na: string;
  labels: {
    reviewCount: string;
    acceptanceRate: string;
    falsePositiveRate: string;
    coverageRate: string;
    latencyP50: string;
    latencyP95: string;
  };
  tooltips: {
    reviewCount: string;
    acceptanceRate: string;
    falsePositiveRate: string;
    coverageRate: string;
    latencyP50: string;
    latencyP95: string;
  };
};

function OverallPanel({ data, na, labels, tooltips }: OverallPanelProps) {
  const metrics = [
    {
      key: 'reviewCount',
      label: labels.reviewCount,
      tooltip: tooltips.reviewCount,
      display: String(data.reviewCount),
    },
    {
      key: 'acceptanceRate',
      label: labels.acceptanceRate,
      tooltip: tooltips.acceptanceRate,
      display: formatRate(data.acceptanceRate, na),
    },
    {
      key: 'falsePositiveRate',
      label: labels.falsePositiveRate,
      tooltip: tooltips.falsePositiveRate,
      display: formatRate(data.falsePositiveRate, na),
    },
    {
      key: 'coverageRate',
      label: labels.coverageRate,
      tooltip: tooltips.coverageRate,
      display: formatRate(data.coverageRate, na),
    },
    {
      key: 'latencyP50',
      label: labels.latencyP50,
      tooltip: tooltips.latencyP50,
      display: formatLatency(data.latencyP50Ms, na),
    },
    {
      key: 'latencyP95',
      label: labels.latencyP95,
      tooltip: tooltips.latencyP95,
      display: formatLatency(data.latencyP95Ms, na),
    },
  ] as const;

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
        gap: '1px',
        backgroundColor: 'var(--hairline)',
        border: '1px solid var(--hairline)',
        marginBottom: '3rem',
      }}
    >
      {metrics.map((m) => (
        <div key={m.key} style={{ backgroundColor: 'var(--bg)' }}>
          <NaMetricCard display={m.display} label={m.label} tooltip={m.tooltip} />
        </div>
      ))}
    </div>
  );
}

// --- Per-repo table ---

type PerRepoTableProps = {
  rows: RepoQualitySnapshot[];
  na: string;
  headers: {
    repo: string;
    reviewCount: string;
    acceptanceRate: string;
    falsePositiveRate: string;
    coverageRate: string;
    latencyP50: string;
    latencyP95: string;
  };
  tooltips: {
    reviewCount: string;
    acceptanceRate: string;
    falsePositiveRate: string;
    coverageRate: string;
    latencyP50: string;
    latencyP95: string;
  };
  emptyMessage: string;
};

function PerRepoTable({ rows, na, headers, tooltips, emptyMessage }: PerRepoTableProps) {
  if (rows.length === 0) {
    return (
      <div className="label-mono" style={{ color: 'var(--graphite)', padding: '2rem 0' }}>
        {emptyMessage}
      </div>
    );
  }

  const cellStyle: React.CSSProperties = {
    fontFamily: 'var(--font-mono)',
    fontSize: '0.75rem',
    color: 'var(--fg)',
    padding: '0.5rem 0.75rem',
    borderBottom: '1px solid var(--hairline)',
    textAlign: 'right',
  };
  const firstCellStyle: React.CSSProperties = {
    ...cellStyle,
    textAlign: 'left',
    maxWidth: '240px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  };
  const headerCellStyle: React.CSSProperties = {
    fontFamily: 'var(--font-mono)',
    fontSize: '0.5625rem',
    fontWeight: 600,
    letterSpacing: '0.1em',
    textTransform: 'uppercase',
    color: 'var(--graphite)',
    padding: '0.5rem 0.75rem',
    borderBottom: '2px solid var(--ink)',
    textAlign: 'right',
    whiteSpace: 'nowrap',
  };

  return (
    <div style={{ overflowX: 'auto' }}>
      <table
        style={{
          width: '100%',
          borderCollapse: 'collapse',
          border: '1px solid var(--hairline)',
        }}
      >
        <thead>
          <tr>
            <th scope="col" style={{ ...headerCellStyle, textAlign: 'left' }}>
              {headers.repo}
            </th>
            <th scope="col" style={headerCellStyle}>
              <Tooltip text={tooltips.reviewCount}>{headers.reviewCount}</Tooltip>
            </th>
            <th scope="col" style={headerCellStyle}>
              <Tooltip text={tooltips.acceptanceRate}>{headers.acceptanceRate}</Tooltip>
            </th>
            <th scope="col" style={headerCellStyle}>
              <Tooltip text={tooltips.falsePositiveRate}>{headers.falsePositiveRate}</Tooltip>
            </th>
            <th scope="col" style={headerCellStyle}>
              <Tooltip text={tooltips.coverageRate}>{headers.coverageRate}</Tooltip>
            </th>
            <th scope="col" style={headerCellStyle}>
              <Tooltip text={tooltips.latencyP50}>{headers.latencyP50}</Tooltip>
            </th>
            <th scope="col" style={headerCellStyle}>
              <Tooltip text={tooltips.latencyP95}>{headers.latencyP95}</Tooltip>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.repo}>
              <td style={firstCellStyle} title={row.repo}>
                {row.repo}
              </td>
              <td style={cellStyle}>{row.reviewCount}</td>
              <td style={cellStyle}>{formatRate(row.acceptanceRate, na)}</td>
              <td style={cellStyle}>{formatRate(row.falsePositiveRate, na)}</td>
              <td style={cellStyle}>{formatRate(row.coverageRate, na)}</td>
              <td style={cellStyle}>{formatLatency(row.latencyP50Ms, na)}</td>
              <td style={cellStyle}>{formatLatency(row.latencyP95Ms, na)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// --- Main page ---

export function QualityMetricsPage() {
  const { t } = useTranslation();
  const { legacy, memberships } = useAuth();

  // Derive installation IDs from context.
  // legacy/mock mode: memberships is empty → use sentinel "0" so hook fires.
  const installationIds: string[] = legacy ? ['0'] : memberships.map((m) => m.installationId);

  const defaultInstallationId = installationIds[0] ?? null;
  const [selectedInstallationId, setSelectedInstallationId] = useState<string | null>(
    defaultInstallationId,
  );
  const [since, setSince] = useState<MetricsSince>('30d');

  const numericInstallationId =
    selectedInstallationId !== null ? Number(selectedInstallationId) : null;

  const { data, isLoading, error, refetch } = useQualityMetrics(numericInstallationId, since);

  const na = t('pages.qualityMetrics.naValue');

  const periodLabels: Record<MetricsSince, string> = {
    '24h': t('pages.qualityMetrics.period24h'),
    '7d': t('pages.qualityMetrics.period7d'),
    '30d': t('pages.qualityMetrics.period30d'),
  };

  const metricLabels = {
    reviewCount: t('pages.qualityMetrics.metricReviewCount'),
    acceptanceRate: t('pages.qualityMetrics.metricAcceptanceRate'),
    falsePositiveRate: t('pages.qualityMetrics.metricFalsePositiveRate'),
    coverageRate: t('pages.qualityMetrics.metricCoverageRate'),
    latencyP50: t('pages.qualityMetrics.metricLatencyP50'),
    latencyP95: t('pages.qualityMetrics.metricLatencyP95'),
  };

  const tooltips = {
    reviewCount: t('pages.qualityMetrics.tooltipReviewCount'),
    acceptanceRate: t('pages.qualityMetrics.tooltipAcceptanceRate'),
    falsePositiveRate: t('pages.qualityMetrics.tooltipFalsePositiveRate'),
    coverageRate: t('pages.qualityMetrics.tooltipCoverageRate'),
    latencyP50: t('pages.qualityMetrics.tooltipLatencyP50'),
    latencyP95: t('pages.qualityMetrics.tooltipLatencyP95'),
  };

  const tableHeaders = {
    repo: t('pages.qualityMetrics.headerRepo'),
    reviewCount: t('pages.qualityMetrics.headerReviewCount'),
    acceptanceRate: t('pages.qualityMetrics.headerAcceptanceRate'),
    falsePositiveRate: t('pages.qualityMetrics.headerFalsePositiveRate'),
    coverageRate: t('pages.qualityMetrics.headerCoverageRate'),
    latencyP50: t('pages.qualityMetrics.headerLatencyP50'),
    latencyP95: t('pages.qualityMetrics.headerLatencyP95'),
  };

  return (
    <StaggerContainer>
      <StaggerItem>
        <SectionHeading
          title={t('pages.qualityMetrics.title')}
          subtitle={t('pages.qualityMetrics.subtitle', { period: since })}
        />
      </StaggerItem>

      {/* Controls row */}
      <StaggerItem>
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: '1rem',
            alignItems: 'center',
            marginBottom: '2rem',
          }}
        >
          <PeriodSelector
            value={since}
            onChange={setSince}
            label={t('pages.qualityMetrics.labelPeriod')}
            labels={periodLabels}
          />
          {installationIds.length > 1 && (
            <InstallationSelector
              installationIds={installationIds}
              selected={selectedInstallationId}
              onChange={setSelectedInstallationId}
              label={t('pages.qualityMetrics.labelInstallation')}
              placeholder={t('pages.qualityMetrics.placeholderInstallation')}
            />
          )}
        </div>
      </StaggerItem>

      {/* No installation state */}
      {installationIds.length === 0 && (
        <StaggerItem>
          <div style={{ padding: '2rem 0' }}>
            <p className="label-mono" style={{ color: 'var(--graphite)', marginBottom: '1rem' }}>
              {t('pages.qualityMetrics.noInstallation')}
            </p>
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
              {t('pages.qualityMetrics.noInstallationLink')}
            </Link>
          </div>
        </StaggerItem>
      )}

      {/* Loading */}
      {isLoading && (
        <StaggerItem>
          <div className="label-mono" style={{ color: 'var(--graphite)', padding: '2rem 0' }}>
            {t('common.loading')}
          </div>
        </StaggerItem>
      )}

      {/* Error */}
      {error && !isLoading && (
        <StaggerItem>
          <ErrorState
            message={t('pages.qualityMetrics.loadingError')}
            onRetry={() => {
              void refetch();
            }}
            retryLabel={t('common.retry')}
          />
        </StaggerItem>
      )}

      {/* Data */}
      {data && (
        <>
          <StaggerItem>
            <h3
              className="label-mono"
              style={{ color: 'var(--graphite)', marginBottom: '1rem', textTransform: 'uppercase' }}
            >
              {t('pages.qualityMetrics.overallTitle')}
            </h3>
            <OverallPanel data={data.overall} na={na} labels={metricLabels} tooltips={tooltips} />
          </StaggerItem>

          <StaggerItem>
            <h3
              className="label-mono"
              style={{
                color: 'var(--graphite)',
                marginBottom: '1rem',
                textTransform: 'uppercase',
              }}
            >
              {t('pages.qualityMetrics.perRepoTitle')}
            </h3>
            <PerRepoTable
              rows={data.perRepo}
              na={na}
              headers={tableHeaders}
              tooltips={tooltips}
              emptyMessage={t('pages.qualityMetrics.emptyPerRepo')}
            />
          </StaggerItem>
        </>
      )}
    </StaggerContainer>
  );
}
