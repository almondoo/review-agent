import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useReviews } from '../api/client.js';
import type {
  PlatformFilter,
  ReviewEvent,
  ReviewOutcomeFilter,
  ReviewsFilters,
  SinceAlias,
} from '../api/types.js';
import type { Column } from '../components/data-table.js';
import { DataTable } from '../components/data-table.js';
import { StaggerContainer, StaggerItem } from '../components/page-transition.js';
import { PlatformBadge } from '../components/platform-badge.js';
import { SectionHeading } from '../components/section-heading.js';
import { StatusBadge } from '../components/status-badge.js';
import { formatCost, formatDateUtc, formatDuration } from '../lib/format.js';

type FilterButtonProps = {
  label: string;
  active: boolean;
  onClick: () => void;
};

function FilterButton({ label, active, onClick }: FilterButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: '0.6875rem',
        letterSpacing: '0.05em',
        padding: '0.25rem 0.5rem',
        border: `1px solid ${active ? 'var(--rust)' : 'var(--hairline)'}`,
        color: active ? 'var(--rust)' : 'var(--graphite)',
        background: 'transparent',
        cursor: 'pointer',
        borderRadius: '2px',
      }}
    >
      {label}
    </button>
  );
}

const LIMIT = 50;

type FiltersState = {
  platform: PlatformFilter;
  outcome: ReviewOutcomeFilter;
  since: SinceAlias;
  repoQuery: string;
  cursor: string | null;
};

export function HistoryPage() {
  const { t } = useTranslation();

  const COLUMNS: Column<ReviewEvent>[] = [
    {
      key: 'date',
      header: t('pages.history.headerDate'),
      mono: true,
      width: '140px',
      render: (row) => (
        <span style={{ color: 'var(--graphite)', fontSize: '0.75rem' }}>
          {formatDateUtc(row.createdAt)}
        </span>
      ),
    },
    {
      key: 'platform',
      header: t('pages.history.headerPlat'),
      width: '60px',
      render: (row) => <PlatformBadge platform={row.platform} />,
    },
    {
      key: 'repo',
      header: t('pages.history.headerRepository'),
      render: (row) => (
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8125rem' }}>
          {row.repoName}
        </span>
      ),
    },
    {
      key: 'pr',
      header: t('pages.history.headerPullRequest'),
      render: (row) => (
        <Link
          to={`/history/${row.id}`}
          style={{
            textDecoration: 'none',
            color: 'inherit',
            fontSize: '0.875rem',
            display: 'block',
          }}
        >
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: '0.6875rem',
              color: 'var(--graphite)',
              marginRight: '0.5rem',
            }}
          >
            #{row.pr.number}
          </span>
          {row.pr.title}
        </Link>
      ),
    },
    {
      key: 'outcome',
      header: t('pages.history.headerOutcome'),
      width: '80px',
      render: (row) => <StatusBadge status={row.outcome} />,
    },
    {
      key: 'cost',
      header: t('pages.history.headerCost'),
      mono: true,
      width: '80px',
      align: 'right',
      render: (row) => <span style={{ color: 'var(--graphite)' }}>{formatCost(row.costUsd)}</span>,
    },
    {
      key: 'duration',
      header: t('pages.history.headerDuration'),
      mono: true,
      width: '80px',
      align: 'right',
      render: (row) => (
        <span style={{ color: 'var(--graphite)' }}>{formatDuration(row.durationMs)}</span>
      ),
    },
  ];

  const [filtersState, setFiltersState] = useState<FiltersState>({
    platform: 'all',
    outcome: 'all',
    since: 'all',
    repoQuery: '',
    cursor: null,
  });

  const filters: ReviewsFilters = {
    limit: LIMIT,
    ...(filtersState.cursor !== null ? { cursor: filtersState.cursor } : {}),
    platform: filtersState.platform,
    outcome: filtersState.outcome,
    since: filtersState.since,
    ...(filtersState.repoQuery !== '' ? { repoQuery: filtersState.repoQuery } : {}),
  };

  const { data, isLoading, error } = useReviews(filters);

  function resetCursor<K extends keyof FiltersState>(key: K, value: FiltersState[K]) {
    setFiltersState((prev) => ({ ...prev, [key]: value, cursor: null }));
  }

  return (
    <StaggerContainer>
      <StaggerItem>
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: '0.5rem',
          }}
        >
          <SectionHeading
            title={t('pages.history.title')}
            subtitle={
              data
                ? t('pages.history.subtitle', { count: data.items.length })
                : t('pages.history.subtitleDefault')
            }
          />
          {data && (
            <span
              className="label-mono"
              style={{
                color: 'var(--graphite)',
                fontSize: '0.6875rem',
                whiteSpace: 'nowrap',
                paddingTop: '0.25rem',
              }}
            >
              {t('pages.history.totalInfo', {
                total: data.total,
                loaded: data.items.length,
              })}
            </span>
          )}
        </div>
      </StaggerItem>

      <StaggerItem>
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: '1rem',
            marginBottom: '1.5rem',
            alignItems: 'center',
          }}
        >
          {/* Platform filter */}
          <div style={{ display: 'flex', gap: '0.25rem' }}>
            {(['all', 'github', 'codecommit'] as const).map((p) => (
              <FilterButton
                key={p}
                label={
                  p === 'all'
                    ? t('pages.history.filterPlatformAll')
                    : p === 'github'
                      ? t('pages.history.filterPlatformGh')
                      : t('pages.history.filterPlatformCc')
                }
                active={filtersState.platform === p}
                onClick={() => resetCursor('platform', p)}
              />
            ))}
          </div>

          {/* Outcome filter */}
          <div style={{ display: 'flex', gap: '0.25rem' }}>
            {(['all', 'approved', 'changes_requested', 'commented', 'failed'] as const).map((o) => (
              <FilterButton
                key={o}
                label={
                  o === 'all'
                    ? t('pages.history.filterOutcomeAll')
                    : o === 'approved'
                      ? t('pages.history.filterOutcomeApproved')
                      : o === 'changes_requested'
                        ? t('pages.history.filterOutcomeChangesRequested')
                        : o === 'commented'
                          ? t('pages.history.filterOutcomeCommented')
                          : t('pages.history.filterOutcomeFailed')
                }
                active={filtersState.outcome === o}
                onClick={() => resetCursor('outcome', o)}
              />
            ))}
          </div>

          {/* Since filter */}
          <div style={{ display: 'flex', gap: '0.25rem' }}>
            {(['24h', '7d', '30d', 'all'] as const).map((s) => (
              <FilterButton
                key={s}
                label={
                  s === '24h'
                    ? t('pages.history.filterSince24h')
                    : s === '7d'
                      ? t('pages.history.filterSince7d')
                      : s === '30d'
                        ? t('pages.history.filterSince30d')
                        : t('pages.history.filterSinceAll')
                }
                active={filtersState.since === s}
                onClick={() => resetCursor('since', s)}
              />
            ))}
          </div>

          {/* Repo query */}
          <input
            type="search"
            placeholder={t('common.repoNameEllipsis')}
            value={filtersState.repoQuery}
            onChange={(e) => resetCursor('repoQuery', e.target.value)}
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: '0.6875rem',
              padding: '0.25rem 0.5rem',
              border: '1px solid var(--hairline)',
              background: 'transparent',
              color: 'inherit',
              borderRadius: '2px',
              width: '160px',
            }}
            aria-label={t('common.filterByRepo')}
          />
        </div>
      </StaggerItem>

      <StaggerItem>
        {isLoading && (
          <div className="label-mono" style={{ color: 'var(--graphite)', padding: '2rem 0' }}>
            {t('common.loading')}
          </div>
        )}
        {error && (
          <div className="label-mono" style={{ color: 'var(--rust)', padding: '2rem 0' }}>
            {t('pages.history.loadingError')}
          </div>
        )}
        {data && (
          <>
            <DataTable
              columns={COLUMNS}
              rows={data.items}
              rowKey={(r) => r.id}
              emptyMessage={t('pages.history.emptyMessage')}
            />
            {data.nextCursor !== null && (
              <div style={{ textAlign: 'center', paddingTop: '1.5rem' }}>
                <button
                  type="button"
                  className="label-mono"
                  onClick={() => setFiltersState((prev) => ({ ...prev, cursor: data.nextCursor }))}
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: '0.6875rem',
                    letterSpacing: '0.05em',
                    padding: '0.375rem 0.75rem',
                    border: '1px solid var(--hairline)',
                    color: 'var(--graphite)',
                    background: 'transparent',
                    cursor: 'pointer',
                    borderRadius: '2px',
                  }}
                >
                  {t('common.loadMore')}
                </button>
              </div>
            )}
          </>
        )}
      </StaggerItem>
    </StaggerContainer>
  );
}
