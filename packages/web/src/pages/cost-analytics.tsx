import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useCostMetrics } from '../api/client.js';
import type { MetricsSince, PeriodCostBucket, RepoCostSnapshot } from '../api/types.js';
import { ErrorState } from '../components/error-state.js';
import { StaggerContainer, StaggerItem } from '../components/page-transition.js';
import { SectionHeading } from '../components/section-heading.js';
import { useAuth } from '../contexts/auth-context.js';

// --- Helpers ---

function formatUsd(value: number): string {
  return `$${value.toFixed(4)}`;
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(value);
}

// --- Tooltip component ---

type TooltipProps = {
  text: string;
  children: React.ReactNode;
};

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

// --- Overall summary cards ---

type OverallCardProps = {
  display: string;
  label: string;
  tooltip: string;
  alert?: boolean;
};

function OverallCard({ display, label, tooltip, alert }: OverallCardProps) {
  return (
    <div
      style={{
        padding: '1.5rem',
        borderTop: `2px solid ${alert ? 'var(--rust)' : 'var(--ink)'}`,
        position: 'relative',
      }}
    >
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
        <div className="metric-value" style={alert ? { color: 'var(--rust)' } : undefined}>
          {display}
        </div>
      </Tooltip>
      <div className="metric-label" style={{ marginTop: '0.5rem' }}>
        <Tooltip text={tooltip}>{label}</Tooltip>
      </div>
    </div>
  );
}

// --- Per-model table ---

type ModelRow = { provider: string; model: string; costUsd: number; callCount: number };

type PerModelTableProps = {
  rows: ModelRow[];
  headers: { providerModel: string; costUsd: string; callCount: string };
  emptyMessage: string;
};

function PerModelTable({ rows, headers, emptyMessage }: PerModelTableProps) {
  if (rows.length === 0) {
    return (
      <div className="label-mono" style={{ color: 'var(--graphite)', padding: '2rem 0' }}>
        {emptyMessage}
      </div>
    );
  }

  const headerCellStyle: React.CSSProperties = {
    fontFamily: 'var(--font-mono)',
    fontSize: '0.5625rem',
    fontWeight: 600,
    letterSpacing: '0.1em',
    textTransform: 'uppercase',
    color: 'var(--graphite)',
    padding: '0.5rem 0.75rem',
    borderBottom: '2px solid var(--ink)',
    textAlign: 'left',
    whiteSpace: 'nowrap',
  };
  const cellStyle: React.CSSProperties = {
    fontFamily: 'var(--font-mono)',
    fontSize: '0.75rem',
    color: 'var(--fg)',
    padding: '0.5rem 0.75rem',
    borderBottom: '1px solid var(--hairline)',
    textAlign: 'left',
  };
  const numericCellStyle: React.CSSProperties = { ...cellStyle, textAlign: 'right' };

  return (
    <div style={{ overflowX: 'auto' }}>
      <table
        style={{ width: '100%', borderCollapse: 'collapse', border: '1px solid var(--hairline)' }}
      >
        <thead>
          <tr>
            <th scope="col" style={headerCellStyle}>
              {headers.providerModel}
            </th>
            <th scope="col" style={{ ...headerCellStyle, textAlign: 'right' }}>
              {headers.costUsd}
            </th>
            <th scope="col" style={{ ...headerCellStyle, textAlign: 'right' }}>
              {headers.callCount}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={`${row.provider}/${row.model}`}>
              <td style={cellStyle}>{`${row.provider} / ${row.model}`}</td>
              <td style={numericCellStyle}>{formatUsd(row.costUsd)}</td>
              <td style={numericCellStyle}>{row.callCount}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// --- Per-repo table ---

type PerRepoTableProps = {
  rows: RepoCostSnapshot[];
  headers: { repo: string; costUsd: string };
  emptyMessage: string;
  nextCursor: string | null;
  onLoadMore: () => void;
  loadMoreLabel: string;
};

function PerRepoTable({
  rows,
  headers,
  emptyMessage,
  nextCursor,
  onLoadMore,
  loadMoreLabel,
}: PerRepoTableProps) {
  if (rows.length === 0) {
    return (
      <div className="label-mono" style={{ color: 'var(--graphite)', padding: '2rem 0' }}>
        {emptyMessage}
      </div>
    );
  }

  const headerCellStyle: React.CSSProperties = {
    fontFamily: 'var(--font-mono)',
    fontSize: '0.5625rem',
    fontWeight: 600,
    letterSpacing: '0.1em',
    textTransform: 'uppercase',
    color: 'var(--graphite)',
    padding: '0.5rem 0.75rem',
    borderBottom: '2px solid var(--ink)',
    textAlign: 'left',
    whiteSpace: 'nowrap',
  };
  const cellStyle: React.CSSProperties = {
    fontFamily: 'var(--font-mono)',
    fontSize: '0.75rem',
    color: 'var(--fg)',
    padding: '0.5rem 0.75rem',
    borderBottom: '1px solid var(--hairline)',
    textAlign: 'left',
    maxWidth: '280px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  };
  const numericCellStyle: React.CSSProperties = {
    ...cellStyle,
    textAlign: 'right',
    maxWidth: undefined,
    overflow: undefined,
    textOverflow: undefined,
    whiteSpace: undefined,
  };

  return (
    <div>
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
              <th scope="col" style={headerCellStyle}>
                {headers.repo}
              </th>
              <th scope="col" style={{ ...headerCellStyle, textAlign: 'right' }}>
                {headers.costUsd}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.repo}>
                <td style={cellStyle} title={row.repo}>
                  {row.repo}
                </td>
                <td style={numericCellStyle}>{formatUsd(row.costUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {nextCursor !== null && (
        <div style={{ marginTop: '0.75rem' }}>
          <button
            type="button"
            onClick={onLoadMore}
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: '0.6875rem',
              fontWeight: 600,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              color: 'var(--fg)',
              backgroundColor: 'transparent',
              border: '1px solid var(--hairline)',
              borderRadius: 'var(--radius)',
              padding: '0.25rem 0.75rem',
              cursor: 'pointer',
            }}
          >
            {loadMoreLabel}
          </button>
        </div>
      )}
    </div>
  );
}

// --- Per-period table ---

type PerPeriodTableProps = {
  rows: PeriodCostBucket[];
  headers: { bucket: string; costUsd: string };
  emptyMessage: string;
};

function PerPeriodTable({ rows, headers, emptyMessage }: PerPeriodTableProps) {
  if (rows.length === 0) {
    return (
      <div className="label-mono" style={{ color: 'var(--graphite)', padding: '2rem 0' }}>
        {emptyMessage}
      </div>
    );
  }

  const headerCellStyle: React.CSSProperties = {
    fontFamily: 'var(--font-mono)',
    fontSize: '0.5625rem',
    fontWeight: 600,
    letterSpacing: '0.1em',
    textTransform: 'uppercase',
    color: 'var(--graphite)',
    padding: '0.5rem 0.75rem',
    borderBottom: '2px solid var(--ink)',
    textAlign: 'left',
    whiteSpace: 'nowrap',
  };
  const cellStyle: React.CSSProperties = {
    fontFamily: 'var(--font-mono)',
    fontSize: '0.75rem',
    color: 'var(--fg)',
    padding: '0.5rem 0.75rem',
    borderBottom: '1px solid var(--hairline)',
    textAlign: 'left',
  };

  return (
    <div style={{ overflowX: 'auto' }}>
      <table
        style={{ width: '100%', borderCollapse: 'collapse', border: '1px solid var(--hairline)' }}
      >
        <thead>
          <tr>
            <th scope="col" style={headerCellStyle}>
              {headers.bucket}
            </th>
            <th scope="col" style={{ ...headerCellStyle, textAlign: 'right' }}>
              {headers.costUsd}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.bucket}>
              <td style={cellStyle}>{row.bucket}</td>
              <td style={{ ...cellStyle, textAlign: 'right' }}>{formatUsd(row.costUsd)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// --- Main page ---

export function CostAnalyticsPage() {
  const { t } = useTranslation();
  const { legacy, memberships } = useAuth();

  const installationIds: string[] = legacy ? ['0'] : memberships.map((m) => m.installationId);
  const defaultInstallationId = installationIds[0] ?? null;

  const [selectedInstallationId, setSelectedInstallationId] = useState<string | null>(
    defaultInstallationId,
  );
  const [since, setSince] = useState<MetricsSince>('30d');
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  // Accumulated per-repo rows across cursor pages.
  const [allRepoRows, setAllRepoRows] = useState<RepoCostSnapshot[]>([]);

  const numericInstallationId =
    selectedInstallationId !== null ? Number(selectedInstallationId) : null;

  const { data, isLoading, error, refetch } = useCostMetrics(numericInstallationId, since, cursor);

  // When a new page of data arrives, accumulate per-repo rows.
  // Reset when since or installation changes (cursor resets to undefined on those changes).
  useEffect(() => {
    if (data === undefined) return;
    if (cursor === undefined) {
      // First page (or after a filter change) — replace accumulated rows.
      setAllRepoRows(data.perRepo.slice());
    } else {
      // Subsequent page — append new rows, avoiding duplicates.
      setAllRepoRows((prev) => {
        const existingRepos = new Set(prev.map((r) => r.repo));
        const newRows = data.perRepo.filter((r) => !existingRepos.has(r.repo));
        return newRows.length > 0 ? [...prev, ...newRows] : prev;
      });
    }
  }, [data, cursor]);

  const handleLoadMore = () => {
    if (data?.nextCursor !== undefined && data.nextCursor !== null) {
      setCursor(data.nextCursor);
    }
  };

  const handlePeriodChange = (v: MetricsSince) => {
    setSince(v);
    setCursor(undefined);
    setAllRepoRows([]);
  };

  const handleInstallationChange = (id: string) => {
    setSelectedInstallationId(id);
    setCursor(undefined);
    setAllRepoRows([]);
  };

  const periodLabels: Record<MetricsSince, string> = {
    '24h': t('pages.costAnalytics.period24h'),
    '7d': t('pages.costAnalytics.period7d'),
    '30d': t('pages.costAnalytics.period30d'),
  };

  // Use accumulated rows when present, otherwise fall back to current page's rows.
  const displayedRepoRows = allRepoRows.length > 0 ? allRepoRows : (data?.perRepo ?? []);

  return (
    <StaggerContainer>
      <StaggerItem>
        <SectionHeading
          title={t('pages.costAnalytics.title')}
          subtitle={t('pages.costAnalytics.subtitle', { period: since })}
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
            onChange={handlePeriodChange}
            label={t('pages.costAnalytics.labelPeriod')}
            labels={periodLabels}
          />
          {installationIds.length > 1 && (
            <InstallationSelector
              installationIds={installationIds}
              selected={selectedInstallationId}
              onChange={handleInstallationChange}
              label={t('pages.costAnalytics.labelInstallation')}
              placeholder={t('pages.costAnalytics.placeholderInstallation')}
            />
          )}
        </div>
      </StaggerItem>

      {/* No installation state */}
      {installationIds.length === 0 && (
        <StaggerItem>
          <div style={{ padding: '2rem 0' }}>
            <p className="label-mono" style={{ color: 'var(--graphite)', marginBottom: '1rem' }}>
              {t('pages.costAnalytics.noInstallation')}
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
              {t('pages.costAnalytics.noInstallationLink')}
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
            message={t('pages.costAnalytics.loadingError')}
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
          {/* Budget alert banner */}
          {data.overall.budgetAlertUsd !== null && (
            <StaggerItem>
              <div
                style={{
                  padding: '0.75rem 1rem',
                  border: '1px solid var(--rust)',
                  borderRadius: 'var(--radius)',
                  backgroundColor: 'var(--bg-raised)',
                  marginBottom: '1.5rem',
                  fontFamily: 'var(--font-mono)',
                  fontSize: '0.75rem',
                  color: 'var(--rust)',
                }}
              >
                {t('pages.costAnalytics.budgetAlertBanner', {
                  threshold: formatUsd(data.overall.budgetAlertUsd),
                  total: formatUsd(data.overall.totalCostUsd),
                })}
              </div>
            </StaggerItem>
          )}

          {/* Overall summary */}
          <StaggerItem>
            <h3
              className="label-mono"
              style={{ color: 'var(--graphite)', marginBottom: '1rem', textTransform: 'uppercase' }}
            >
              {t('pages.costAnalytics.overallTitle')}
            </h3>
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
              {[
                {
                  key: 'totalCostUsd',
                  display: formatUsd(data.overall.totalCostUsd),
                  label: t('pages.costAnalytics.metricTotalCost'),
                  tooltip: t('pages.costAnalytics.tooltipTotalCost'),
                  alert: data.overall.budgetAlertUsd !== null,
                },
                {
                  key: 'callCount',
                  display: String(data.overall.callCount),
                  label: t('pages.costAnalytics.metricCallCount'),
                  tooltip: t('pages.costAnalytics.tooltipCallCount'),
                  alert: false,
                },
                {
                  key: 'inputTokens',
                  display: formatTokens(data.overall.totalInputTokens),
                  label: t('pages.costAnalytics.metricInputTokens'),
                  tooltip: t('pages.costAnalytics.tooltipInputTokens'),
                  alert: false,
                },
                {
                  key: 'outputTokens',
                  display: formatTokens(data.overall.totalOutputTokens),
                  label: t('pages.costAnalytics.metricOutputTokens'),
                  tooltip: t('pages.costAnalytics.tooltipOutputTokens'),
                  alert: false,
                },
                {
                  key: 'cacheReadTokens',
                  display: formatTokens(data.overall.totalCacheReadTokens),
                  label: t('pages.costAnalytics.metricCacheReadTokens'),
                  tooltip: t('pages.costAnalytics.tooltipCacheReadTokens'),
                  alert: false,
                },
                {
                  key: 'cacheCreationTokens',
                  display: formatTokens(data.overall.totalCacheCreationTokens),
                  label: t('pages.costAnalytics.metricCacheCreationTokens'),
                  tooltip: t('pages.costAnalytics.tooltipCacheCreationTokens'),
                  alert: false,
                },
              ].map((m) => (
                <div key={m.key} style={{ backgroundColor: 'var(--bg)' }}>
                  <OverallCard
                    display={m.display}
                    label={m.label}
                    tooltip={m.tooltip}
                    alert={m.alert}
                  />
                </div>
              ))}
            </div>
          </StaggerItem>

          {/* Per-model table */}
          <StaggerItem>
            <h3
              className="label-mono"
              style={{ color: 'var(--graphite)', marginBottom: '1rem', textTransform: 'uppercase' }}
            >
              {t('pages.costAnalytics.perModelTitle')}
            </h3>
            <PerModelTable
              rows={data.perModel}
              headers={{
                providerModel: t('pages.costAnalytics.headerProviderModel'),
                costUsd: t('pages.costAnalytics.headerCostUsd'),
                callCount: t('pages.costAnalytics.headerCallCount'),
              }}
              emptyMessage={t('pages.costAnalytics.emptyPerModel')}
            />
          </StaggerItem>

          {/* Per-repo table */}
          <StaggerItem>
            <h3
              className="label-mono"
              style={{
                color: 'var(--graphite)',
                marginBottom: '1rem',
                marginTop: '2rem',
                textTransform: 'uppercase',
              }}
            >
              {t('pages.costAnalytics.perRepoTitle')}
            </h3>
            <PerRepoTable
              rows={displayedRepoRows}
              headers={{
                repo: t('pages.costAnalytics.headerRepo'),
                costUsd: t('pages.costAnalytics.headerCostUsd'),
              }}
              emptyMessage={t('pages.costAnalytics.emptyPerRepo')}
              nextCursor={data.nextCursor}
              onLoadMore={handleLoadMore}
              loadMoreLabel={t('common.loadMore')}
            />
          </StaggerItem>

          {/* Per-period table */}
          <StaggerItem>
            <h3
              className="label-mono"
              style={{
                color: 'var(--graphite)',
                marginBottom: '1rem',
                marginTop: '2rem',
                textTransform: 'uppercase',
              }}
            >
              {t('pages.costAnalytics.perPeriodTitle')}
            </h3>
            <PerPeriodTable
              rows={data.perPeriod}
              headers={{
                bucket: t('pages.costAnalytics.headerBucket'),
                costUsd: t('pages.costAnalytics.headerCostUsd'),
              }}
              emptyMessage={t('pages.costAnalytics.emptyPerPeriod')}
            />
          </StaggerItem>
        </>
      )}
    </StaggerContainer>
  );
}
