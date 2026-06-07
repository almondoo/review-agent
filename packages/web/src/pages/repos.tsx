import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router-dom';
import { useDeleteRepo, useIntegrations, usePatchRepo, useRepos } from '../api/client.js';
import type { RepoSummary } from '../api/types.js';
import { ConfirmDialog } from '../components/confirm-dialog.js';
import type { Column } from '../components/data-table.js';
import { DataTable } from '../components/data-table.js';
import { EmptyState } from '../components/empty-state.js';
import { ErrorState } from '../components/error-state.js';
import { Hairline } from '../components/hairline.js';
import { StaggerContainer, StaggerItem } from '../components/page-transition.js';
import { PlatformBadge } from '../components/platform-badge.js';
import { SectionHeading } from '../components/section-heading.js';
import { StatusBadge } from '../components/status-badge.js';
import { ToastContainer, useToast } from '../components/toast.js';
import { useAuth } from '../contexts/auth-context.js';
import { formatRelativeDate } from '../lib/format.js';

const PAGE_SIZE = 25;
type StatusFilter = 'all' | 'enabled' | 'disabled';

export function ReposPage() {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const { data: repos, isLoading, error, refetch } = useRepos();
  const { data: integrations } = useIntegrations();
  const patchRepo = usePatchRepo();
  const deleteRepo = useDeleteRepo();
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const { toast, messages, dismiss } = useToast();
  const { maxRole, legacy } = useAuth();
  const canEdit = legacy || maxRole === 'editor' || maxRole === 'admin';
  const canAdmin = legacy || maxRole === 'admin';

  // URL-persisted filter/search/page state
  const searchQuery = searchParams.get('q') ?? '';
  const statusFilter = (searchParams.get('status') ?? 'all') as StatusFilter;
  const page = Math.max(1, Number(searchParams.get('page') ?? '1'));

  function setParam(key: string, value: string) {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (value === '' || value === 'all' || value === '1') {
        next.delete(key);
      } else {
        next.set(key, value);
      }
      return next;
    });
  }

  function setSearchQuery(value: string) {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (value === '') {
        next.delete('q');
      } else {
        next.set('q', value);
      }
      // reset page on new search
      next.delete('page');
      return next;
    });
  }

  function setStatusFilter(value: StatusFilter) {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (value === 'all') {
        next.delete('status');
      } else {
        next.set('status', value);
      }
      next.delete('page');
      return next;
    });
  }

  function setPage(value: number) {
    setParam('page', String(value));
  }

  const columns: Column<RepoSummary>[] = [
    {
      key: 'platform',
      header: t('pages.repos.headerPlatform'),
      width: '100px',
      render: (row) => <PlatformBadge platform={row.platform} />,
    },
    {
      key: 'name',
      header: t('pages.repos.headerRepository'),
      render: (row) => (
        <Link
          to={`/repos/${row.id}`}
          onClick={(e) => e.stopPropagation()}
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: '0.8125rem',
            color: 'var(--ink)',
            textDecoration: 'none',
          }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLAnchorElement).style.color = 'var(--rust)';
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLAnchorElement).style.color = 'var(--ink)';
          }}
        >
          {row.name}
        </Link>
      ),
    },
    {
      key: 'status',
      header: t('pages.repos.headerStatus'),
      width: '80px',
      render: (row) => <StatusBadge status={row.lastOutcome ?? 'queued'} />,
    },
    {
      key: 'lastReview',
      header: t('pages.repos.headerLastReview'),
      mono: true,
      width: '120px',
      render: (row) => (
        <span style={{ color: 'var(--graphite)', fontSize: '0.75rem' }}>
          {formatRelativeDate(row.lastReviewAt)}
        </span>
      ),
    },
    {
      key: 'enabled',
      header: t('pages.repos.headerEnabled'),
      width: '80px',
      align: 'center',
      render: (row) => (
        <button
          type="button"
          disabled={!canEdit}
          onClick={(e) => {
            e.stopPropagation();
            if (canEdit) patchRepo.mutate({ id: row.id, body: { enabled: !row.enabled } });
          }}
          aria-label={
            row.enabled
              ? t('pages.repos.disableLabel', { name: row.name })
              : t('pages.repos.enableLabel', { name: row.name })
          }
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: '0.625rem',
            fontWeight: 600,
            letterSpacing: '0.06em',
            color: row.enabled ? 'var(--moss)' : 'var(--graphite)',
            padding: '0.2rem 0.4rem',
            border: `1px solid ${row.enabled ? 'var(--moss)' : 'var(--hairline)'}`,
            borderRadius: 'var(--radius)',
            transition: 'all var(--transition-fast)',
            opacity: canEdit ? 1 : 0.35,
            cursor: canEdit ? 'pointer' : 'not-allowed',
          }}
        >
          {row.enabled ? t('common.on') : t('common.off')}
        </button>
      ),
    },
    {
      key: 'delete',
      header: '',
      width: '60px',
      align: 'right',
      render: (row) =>
        canAdmin ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setPendingDeleteId(row.id);
            }}
            className="label-mono"
            style={{ color: 'var(--graphite)', opacity: 0.4 }}
            aria-label={t('pages.repos.deleteLabel', { name: row.name })}
          >
            {t('common.del')}
          </button>
        ) : null,
    },
  ];

  const pendingRepo = repos?.find((r) => r.id === pendingDeleteId);

  // Derive GitHub connection status from integrations data
  const isGithubConnected =
    integrations === undefined ||
    (integrations.github.configured && integrations.github.installationCount > 0);

  // Client-side filter + search + pagination
  const filteredRepos = useMemo(() => {
    if (!repos) return [];
    let result = repos;
    if (statusFilter === 'enabled') {
      result = result.filter((r) => r.enabled);
    } else if (statusFilter === 'disabled') {
      result = result.filter((r) => !r.enabled);
    }
    if (searchQuery.trim() !== '') {
      const q = searchQuery.trim().toLowerCase();
      result = result.filter((r) => r.name.toLowerCase().includes(q));
    }
    return result;
  }, [repos, statusFilter, searchQuery]);

  const totalPages = Math.max(1, Math.ceil(filteredRepos.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pagedRepos = filteredRepos.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  return (
    <>
      <StaggerContainer>
        <StaggerItem>
          <div
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              justifyContent: 'space-between',
              marginBottom: '0.5rem',
            }}
          >
            <SectionHeading
              title={t('pages.repos.title')}
              {...(repos ? { subtitle: t('pages.repos.subtitle', { count: repos.length }) } : {})}
            />
            {canAdmin && (
              <Link
                to="/repos/new"
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: '0.6875rem',
                  fontWeight: 600,
                  letterSpacing: '0.08em',
                  color: 'var(--rust)',
                  border: '1px solid var(--rust)',
                  padding: '0.375rem 0.75rem',
                  borderRadius: 'var(--radius)',
                  whiteSpace: 'nowrap',
                  marginTop: '0.25rem',
                  display: 'inline-block',
                }}
              >
                {t('common.addRepo')}
              </Link>
            )}
          </div>
        </StaggerItem>

        <StaggerItem>
          <Hairline style={{ marginBottom: '0' }} />
        </StaggerItem>

        {/* Search + status filter controls */}
        {repos && (
          <StaggerItem>
            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: '0.75rem',
                alignItems: 'center',
                padding: '0.75rem 0',
              }}
            >
              <input
                type="search"
                placeholder={t('pages.repos.searchPlaceholder')}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                aria-label={t('pages.repos.searchAriaLabel')}
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: '0.6875rem',
                  padding: '0.25rem 0.5rem',
                  border: '1px solid var(--hairline)',
                  background: 'transparent',
                  color: 'inherit',
                  borderRadius: '2px',
                  width: '180px',
                }}
              />
              <div style={{ display: 'flex', gap: '0.25rem' }}>
                {(['all', 'enabled', 'disabled'] as const).map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setStatusFilter(s)}
                    aria-pressed={statusFilter === s}
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: '0.6875rem',
                      letterSpacing: '0.05em',
                      padding: '0.25rem 0.5rem',
                      border: `1px solid ${statusFilter === s ? 'var(--rust)' : 'var(--hairline)'}`,
                      color: statusFilter === s ? 'var(--rust)' : 'var(--graphite)',
                      background: 'transparent',
                      cursor: 'pointer',
                      borderRadius: '2px',
                    }}
                  >
                    {s === 'all'
                      ? t('pages.repos.filterAll')
                      : s === 'enabled'
                        ? t('pages.repos.filterEnabled')
                        : t('pages.repos.filterDisabled')}
                  </button>
                ))}
              </div>
            </div>
          </StaggerItem>
        )}

        <StaggerItem>
          {isLoading && (
            <div className="label-mono" style={{ color: 'var(--graphite)', padding: '2rem 0' }}>
              {t('common.loading')}
            </div>
          )}
          {error && !isLoading && (
            <ErrorState
              message={t('pages.repos.loadingError')}
              onRetry={() => {
                void refetch();
              }}
              retryLabel={t('common.retry')}
            />
          )}
          {!error && !isLoading && repos !== undefined && !isGithubConnected && (
            <EmptyState
              message={t('pages.repos.githubNotConnected')}
              ctaLabel={t('pages.repos.githubNotConnectedCta')}
              ctaHref="/integrations"
            />
          )}
          {!error &&
            !isLoading &&
            repos !== undefined &&
            isGithubConnected &&
            repos.length === 0 && (
              <EmptyState
                message={t('pages.repos.emptyConnectedNoRepos')}
                {...(canAdmin
                  ? {
                      ctaLabel: t('pages.repos.emptyConnectedCta'),
                      ctaHref: '/repos/new',
                    }
                  : {})}
              />
            )}
          {!error && !isLoading && repos !== undefined && isGithubConnected && repos.length > 0 && (
            <>
              <DataTable
                columns={columns}
                rows={pagedRepos}
                rowKey={(r) => r.id}
                emptyMessage={t('pages.repos.emptyMessage')}
              />
              {totalPages > 1 && (
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.75rem',
                    paddingTop: '1rem',
                    fontFamily: 'var(--font-mono)',
                    fontSize: '0.6875rem',
                    color: 'var(--graphite)',
                  }}
                >
                  <button
                    type="button"
                    disabled={safePage <= 1}
                    onClick={() => setPage(safePage - 1)}
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: '0.6875rem',
                      padding: '0.25rem 0.5rem',
                      border: '1px solid var(--hairline)',
                      color: 'var(--graphite)',
                      background: 'transparent',
                      cursor: safePage <= 1 ? 'not-allowed' : 'pointer',
                      opacity: safePage <= 1 ? 0.4 : 1,
                      borderRadius: '2px',
                    }}
                  >
                    {t('pages.repos.prevPage')}
                  </button>
                  <span>{t('pages.repos.pageInfo', { page: safePage, total: totalPages })}</span>
                  <button
                    type="button"
                    disabled={safePage >= totalPages}
                    onClick={() => setPage(safePage + 1)}
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: '0.6875rem',
                      padding: '0.25rem 0.5rem',
                      border: '1px solid var(--hairline)',
                      color: 'var(--graphite)',
                      background: 'transparent',
                      cursor: safePage >= totalPages ? 'not-allowed' : 'pointer',
                      opacity: safePage >= totalPages ? 0.4 : 1,
                      borderRadius: '2px',
                    }}
                  >
                    {t('pages.repos.nextPage')}
                  </button>
                </div>
              )}
            </>
          )}
        </StaggerItem>
      </StaggerContainer>

      <ConfirmDialog
        isOpen={pendingDeleteId !== null}
        title={t('dialog.confirmDelete.title')}
        message={t('dialog.confirmDelete.message', { name: pendingRepo?.name ?? '' })}
        confirmLabel={t('dialog.confirmDelete.confirm')}
        cancelLabel={t('dialog.confirmDelete.cancel')}
        tone="danger"
        onConfirm={() => {
          if (pendingDeleteId !== null) {
            const idToDelete = pendingDeleteId;
            setPendingDeleteId(null);
            deleteRepo.mutate(idToDelete, {
              onError: () => {
                toast(t('toast.deleteFailed'), 'error');
              },
            });
          } else {
            setPendingDeleteId(null);
          }
        }}
        onCancel={() => setPendingDeleteId(null)}
      />
      <ToastContainer messages={messages} onDismiss={dismiss} />
    </>
  );
}
