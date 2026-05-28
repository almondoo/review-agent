import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  useDeleteRepo,
  usePatchRepo,
  useRepoDetail,
  useRepoMetrics,
  useRepoPrompt,
  useRepoReviews,
} from '../api/client.js';
import type { ReviewEvent } from '../api/types.js';
import type { Column } from '../components/data-table.js';
import { DataTable } from '../components/data-table.js';
import { Hairline } from '../components/hairline.js';
import { MetricCard } from '../components/metric-card.js';
import { StaggerContainer, StaggerItem } from '../components/page-transition.js';
import { PlatformBadge } from '../components/platform-badge.js';
import { SectionHeading } from '../components/section-heading.js';
import { StatusBadge } from '../components/status-badge.js';
import { formatDateUtc, formatDuration } from '../lib/format.js';

const REVIEW_COLUMNS: Column<ReviewEvent>[] = [
  {
    key: 'pr',
    header: 'PR',
    render: (row) => (
      <Link
        to={`/history/${row.id}`}
        style={{ fontFamily: 'var(--font-mono)', fontSize: '0.6875rem', color: 'var(--graphite)' }}
      >
        #{row.pr.number}
      </Link>
    ),
    width: '60px',
  },
  {
    key: 'title',
    header: 'Title',
    render: (row) => (
      <Link to={`/history/${row.id}`} style={{ fontSize: '0.875rem', color: 'var(--fg)' }}>
        {row.pr.title}
      </Link>
    ),
  },
  {
    key: 'outcome',
    header: 'Outcome',
    width: '80px',
    render: (row) => <StatusBadge status={row.outcome} />,
  },
  {
    key: 'cost',
    header: 'Cost',
    mono: true,
    width: '70px',
    align: 'right',
    render: (row) => (
      <span style={{ color: 'var(--graphite)', fontSize: '0.75rem' }}>
        ${row.costUsd.toFixed(3)}
      </span>
    ),
  },
  {
    key: 'duration',
    header: 'Duration',
    mono: true,
    width: '80px',
    align: 'right',
    render: (row) => (
      <span style={{ color: 'var(--graphite)', fontSize: '0.75rem' }}>
        {formatDuration(row.durationMs)}
      </span>
    ),
  },
];

export function RepoDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const safeId = id ?? '';

  const { data: repo, isLoading: repoLoading, error: repoError } = useRepoDetail(safeId);
  const { data: metrics } = useRepoMetrics(safeId);
  const { data: reviews } = useRepoReviews(safeId, 10);
  const { data: promptData, isLoading: promptLoading, error: promptError } = useRepoPrompt(safeId);
  const patchRepo = usePatchRepo();
  const deleteRepo = useDeleteRepo();

  if (repoLoading) {
    return (
      <div className="label-mono" style={{ color: 'var(--graphite)', padding: '2rem 0' }}>
        [LOADING...]
      </div>
    );
  }

  if (repoError || !repo) {
    return (
      <div style={{ padding: '2rem 0' }}>
        <p className="label-mono" style={{ color: 'var(--rust)', marginBottom: '1rem' }}>
          [ERROR] Repository not found.
        </p>
        <Link to="/repos" className="label-mono" style={{ color: 'var(--graphite)' }}>
          [← Back to Repos]
        </Link>
      </div>
    );
  }

  function handleDelete() {
    if (!window.confirm(`Delete ${repo?.name}? This cannot be undone.`)) return;
    deleteRepo.mutate(safeId, { onSuccess: () => navigate('/repos') });
  }

  return (
    <StaggerContainer>
      {/* Breadcrumb */}
      <StaggerItem>
        <div className="label-mono" style={{ color: 'var(--graphite)', marginBottom: '0.5rem' }}>
          <Link to="/repos" style={{ color: 'var(--graphite)' }}>
            Repos
          </Link>
          {' / '}
          {repo.name}
        </div>
      </StaggerItem>

      {/* Header */}
      <StaggerItem>
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            gap: '1rem',
            flexWrap: 'wrap',
            marginBottom: '0.5rem',
          }}
        >
          <div>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.75rem',
                marginBottom: '0.25rem',
              }}
            >
              <PlatformBadge platform={repo.platform} />
              <StatusBadge status={repo.lastOutcome ?? 'queued'} />
            </div>
            <h1
              style={{
                fontFamily: 'var(--font-display)',
                fontSize: 'clamp(28px, 3vw, 48px)',
                fontWeight: 800,
                letterSpacing: '-0.04em',
                lineHeight: 1,
                fontVariationSettings: "'opsz' 72, 'SOFT' 60",
              }}
            >
              {repo.name}
            </h1>
            <p className="label-mono" style={{ color: 'var(--graphite)', marginTop: '0.375rem' }}>
              {repo.systemPromptPresent ? '[CUSTOM PROMPT]' : '[DEFAULT PROMPT]'} — updated{' '}
              {formatDateUtc(repo.updatedAt)}
            </p>
          </div>

          {/* Actions */}
          <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexShrink: 0 }}>
            <button
              type="button"
              onClick={() => patchRepo.mutate({ id: safeId, body: { enabled: !repo.enabled } })}
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: '0.625rem',
                fontWeight: 600,
                letterSpacing: '0.06em',
                color: repo.enabled ? 'var(--moss)' : 'var(--graphite)',
                border: `1px solid ${repo.enabled ? 'var(--moss)' : 'var(--hairline)'}`,
                padding: '0.375rem 0.625rem',
                borderRadius: 'var(--radius)',
              }}
              aria-label={`${repo.enabled ? 'Disable' : 'Enable'} repository`}
            >
              {repo.enabled ? '[ENABLED]' : '[DISABLED]'}
            </button>

            <Link
              to={`/repos/${safeId}/prompt`}
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: '0.625rem',
                fontWeight: 600,
                letterSpacing: '0.06em',
                color: 'var(--rust)',
                border: '1px solid var(--rust)',
                padding: '0.375rem 0.625rem',
                borderRadius: 'var(--radius)',
                display: 'inline-block',
              }}
            >
              [EDIT PROMPT]
            </Link>

            <button
              type="button"
              onClick={handleDelete}
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: '0.625rem',
                fontWeight: 600,
                letterSpacing: '0.06em',
                color: 'var(--graphite)',
                border: '1px solid var(--hairline)',
                padding: '0.375rem 0.625rem',
                borderRadius: 'var(--radius)',
                opacity: 0.6,
              }}
              aria-label="Delete repository"
            >
              [DELETE]
            </button>
          </div>
        </div>
        <Hairline style={{ marginTop: '1rem', marginBottom: '2rem' }} />
      </StaggerItem>

      {/* Metrics */}
      {metrics && (
        <StaggerItem>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
              gap: '1px',
              backgroundColor: 'var(--hairline)',
              border: '1px solid var(--hairline)',
              marginBottom: '3rem',
            }}
          >
            {[
              { value: metrics.totalReviews, label: 'Total Reviews' },
              { value: metrics.reviewsLast30d, label: 'Last 30 Days' },
              { value: metrics.avgDurationMs / 1000, label: 'Avg Duration (s)', decimals: 1 },
              { value: metrics.totalCostUsd, label: 'Total Cost (USD)', prefix: '$', decimals: 3 },
            ].map((m) => (
              <div key={m.label} style={{ backgroundColor: 'var(--bg)' }}>
                <MetricCard
                  value={m.value}
                  label={m.label}
                  prefix={m.prefix ?? ''}
                  decimals={m.decimals ?? 0}
                />
              </div>
            ))}
          </div>
        </StaggerItem>
      )}

      {/* Recent Reviews */}
      <StaggerItem>
        <SectionHeading title="Recent Reviews" subtitle="Last 10 events" />
        {reviews && (
          <DataTable
            columns={REVIEW_COLUMNS}
            rows={reviews.items}
            rowKey={(r) => r.id}
            emptyMessage="[EMPTY] — No reviews yet."
          />
        )}
      </StaggerItem>

      {/* System Prompt Preview */}
      <StaggerItem>
        <div style={{ marginTop: '3rem' }}>
          <SectionHeading title="System Prompt" subtitle="Current configuration" />
          <div
            style={{
              backgroundColor: 'var(--bg-raised)',
              border: '1px solid var(--hairline)',
              padding: '1.25rem',
              borderRadius: 'var(--radius)',
            }}
          >
            {repo.systemPromptPresent ? (
              <>
                {promptLoading && (
                  <span
                    className="label-mono"
                    style={{ color: 'var(--graphite)', fontSize: '0.75rem' }}
                  >
                    [LOADING PROMPT...]
                  </span>
                )}
                {!promptLoading && promptError && (
                  <span
                    className="label-mono"
                    style={{ color: 'var(--rust)', fontSize: '0.75rem' }}
                  >
                    [ERROR LOADING PROMPT]
                  </span>
                )}
                {!promptLoading && !promptError && promptData?.systemPrompt && (
                  <pre
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: '0.75rem',
                      lineHeight: 1.6,
                      color: 'var(--fg)',
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                    }}
                  >
                    {promptData.systemPrompt.length > 200
                      ? `${promptData.systemPrompt.slice(0, 200)} …`
                      : promptData.systemPrompt}
                  </pre>
                )}
                <Link
                  to={`/repos/${safeId}/prompt`}
                  style={{
                    display: 'inline-block',
                    marginTop: '0.75rem',
                    fontFamily: 'var(--font-mono)',
                    fontSize: '0.625rem',
                    fontWeight: 600,
                    letterSpacing: '0.08em',
                    color: 'var(--rust)',
                  }}
                >
                  [EDIT PROMPT →]
                </Link>
              </>
            ) : (
              <div>
                <p
                  className="label-mono"
                  style={{ color: 'var(--graphite)', marginBottom: '0.75rem' }}
                >
                  [DEFAULT] Using built-in system prompt.
                </p>
                <Link
                  to={`/repos/${safeId}/prompt`}
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: '0.625rem',
                    fontWeight: 600,
                    letterSpacing: '0.08em',
                    color: 'var(--rust)',
                  }}
                >
                  [CUSTOMIZE PROMPT →]
                </Link>
              </div>
            )}
          </div>
        </div>
      </StaggerItem>
    </StaggerContainer>
  );
}
