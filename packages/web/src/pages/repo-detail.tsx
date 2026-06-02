import { useState } from 'react';
import { useTranslation } from 'react-i18next';
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
import { ConfirmDialog } from '../components/confirm-dialog.js';
import type { Column } from '../components/data-table.js';
import { DataTable } from '../components/data-table.js';
import { Hairline } from '../components/hairline.js';
import { MetricCard } from '../components/metric-card.js';
import { StaggerContainer, StaggerItem } from '../components/page-transition.js';
import { PlatformBadge } from '../components/platform-badge.js';
import { SectionHeading } from '../components/section-heading.js';
import { StatusBadge } from '../components/status-badge.js';
import { ToastContainer, useToast } from '../components/toast.js';
import { formatDateUtc, formatDuration } from '../lib/format.js';

export function RepoDetailPage() {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const safeId = id ?? '';

  const REVIEW_COLUMNS: Column<ReviewEvent>[] = [
    {
      key: 'pr',
      header: t('pages.repoDetail.headerPr'),
      render: (row) => (
        <Link
          to={`/history/${row.id}`}
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: '0.6875rem',
            color: 'var(--graphite)',
          }}
        >
          #{row.pr.number}
        </Link>
      ),
      width: '60px',
    },
    {
      key: 'title',
      header: t('pages.repoDetail.headerTitle'),
      render: (row) => (
        <Link to={`/history/${row.id}`} style={{ fontSize: '0.875rem', color: 'var(--fg)' }}>
          {row.pr.title}
        </Link>
      ),
    },
    {
      key: 'outcome',
      header: t('pages.repoDetail.headerOutcome'),
      width: '80px',
      render: (row) => <StatusBadge status={row.outcome} />,
    },
    {
      key: 'cost',
      header: t('pages.repoDetail.headerCost'),
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
      header: t('pages.repoDetail.headerDuration'),
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

  const { data: repo, isLoading: repoLoading, error: repoError } = useRepoDetail(safeId);
  const { data: metrics } = useRepoMetrics(safeId);
  const { data: reviews } = useRepoReviews(safeId, 10);
  const { data: promptData, isLoading: promptLoading, error: promptError } = useRepoPrompt(safeId);
  const patchRepo = usePatchRepo();
  const deleteRepo = useDeleteRepo();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const { toast, messages, dismiss } = useToast();

  if (repoLoading) {
    return (
      <div className="label-mono" style={{ color: 'var(--graphite)', padding: '2rem 0' }}>
        {t('common.loading')}
      </div>
    );
  }

  if (repoError || !repo) {
    return (
      <div style={{ padding: '2rem 0' }}>
        <p className="label-mono" style={{ color: 'var(--rust)', marginBottom: '1rem' }}>
          {t('pages.repoDetail.loadingError')}
        </p>
        <Link to="/repos" className="label-mono" style={{ color: 'var(--graphite)' }}>
          {t('pages.repoDetail.backToRepos')}
        </Link>
      </div>
    );
  }

  function handleDelete() {
    setDeleteOpen(true);
  }

  function handleDeleteConfirm() {
    setDeleteOpen(false);
    deleteRepo.mutate(safeId, {
      onSuccess: () => navigate('/repos'),
      onError: () => {
        toast(t('toast.deleteFailed'), 'error');
      },
    });
  }

  function handleDeleteCancel() {
    setDeleteOpen(false);
  }

  return (
    <>
      <StaggerContainer>
        {/* Breadcrumb */}
        <StaggerItem>
          <div className="label-mono" style={{ color: 'var(--graphite)', marginBottom: '0.5rem' }}>
            <Link to="/repos" style={{ color: 'var(--graphite)' }}>
              {t('pages.repoDetail.repos')}
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
                {repo.systemPromptPresent
                  ? t('pages.repoDetail.customPrompt')
                  : t('pages.repoDetail.defaultPrompt')}{' '}
                — {t('pages.repoDetail.updatedAt')} {formatDateUtc(repo.updatedAt)}
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
                aria-label={
                  repo.enabled
                    ? t('pages.repoDetail.disabledLabel')
                    : t('pages.repoDetail.enabledLabel')
                }
              >
                {repo.enabled ? t('pages.repoDetail.enabled') : t('pages.repoDetail.disabled')}
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
                {t('pages.repoDetail.editPrompt')}
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
                aria-label={t('pages.repoDetail.deleteLabel')}
              >
                {t('pages.repoDetail.delete')}
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
                { value: metrics.totalReviews, label: t('pages.repoDetail.totalReviews') },
                { value: metrics.reviewsLast30d, label: t('pages.repoDetail.last30Days') },
                {
                  value: metrics.avgDurationMs / 1000,
                  label: t('pages.repoDetail.avgDuration'),
                  decimals: 1,
                },
                {
                  value: metrics.totalCostUsd,
                  label: t('pages.repoDetail.totalCost'),
                  prefix: '$',
                  decimals: 3,
                },
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
          <SectionHeading
            title={t('pages.repoDetail.recentReviews')}
            subtitle={t('pages.repoDetail.recentReviewsSubtitle')}
          />
          {reviews && (
            <DataTable
              columns={REVIEW_COLUMNS}
              rows={reviews.items}
              rowKey={(r) => r.id}
              emptyMessage={t('pages.repoDetail.emptyReviews')}
            />
          )}
        </StaggerItem>

        {/* System Prompt Preview */}
        <StaggerItem>
          <div style={{ marginTop: '3rem' }}>
            <SectionHeading
              title={t('pages.repoDetail.systemPrompt')}
              subtitle={t('pages.repoDetail.systemPromptSubtitle')}
            />
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
                      {t('pages.repoDetail.loadingPrompt')}
                    </span>
                  )}
                  {!promptLoading && promptError && (
                    <span
                      className="label-mono"
                      style={{ color: 'var(--rust)', fontSize: '0.75rem' }}
                    >
                      {t('pages.repoDetail.errorLoadingPrompt')}
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
                    {t('pages.repoDetail.editPromptLink')}
                  </Link>
                </>
              ) : (
                <div>
                  <p
                    className="label-mono"
                    style={{ color: 'var(--graphite)', marginBottom: '0.75rem' }}
                  >
                    {t('pages.repoDetail.defaultPromptLabel')}
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
                    {t('pages.repoDetail.customizePromptLink')}
                  </Link>
                </div>
              )}
            </div>
          </div>
        </StaggerItem>
      </StaggerContainer>

      <ConfirmDialog
        isOpen={deleteOpen}
        title={t('dialog.confirmDelete.title')}
        message={t('dialog.confirmDelete.message', { name: repo.name })}
        confirmLabel={t('dialog.confirmDelete.confirm')}
        cancelLabel={t('dialog.confirmDelete.cancel')}
        tone="danger"
        onConfirm={handleDeleteConfirm}
        onCancel={handleDeleteCancel}
      />
      <ToastContainer messages={messages} onDismiss={dismiss} />
    </>
  );
}
