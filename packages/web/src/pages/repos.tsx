import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useDeleteRepo, usePatchRepo, useRepos } from '../api/client.js';
import type { RepoSummary } from '../api/types.js';
import { ConfirmDialog } from '../components/confirm-dialog.js';
import type { Column } from '../components/data-table.js';
import { DataTable } from '../components/data-table.js';
import { Hairline } from '../components/hairline.js';
import { StaggerContainer, StaggerItem } from '../components/page-transition.js';
import { PlatformBadge } from '../components/platform-badge.js';
import { SectionHeading } from '../components/section-heading.js';
import { StatusBadge } from '../components/status-badge.js';
import { ToastContainer, useToast } from '../components/toast.js';
import { useAuth } from '../contexts/auth-context.js';
import { formatRelativeDate } from '../lib/format.js';

export function ReposPage() {
  const { t } = useTranslation();
  const { data: repos, isLoading, error } = useRepos();
  const patchRepo = usePatchRepo();
  const deleteRepo = useDeleteRepo();
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const { toast, messages, dismiss } = useToast();
  const { maxRole, legacy } = useAuth();
  // Use maxRole as the global gate; legacy mode grants all permissions.
  const canEdit = legacy || maxRole === 'editor' || maxRole === 'admin';
  const canAdmin = legacy || maxRole === 'admin';

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

        <StaggerItem>
          {isLoading && (
            <div className="label-mono" style={{ color: 'var(--graphite)', padding: '2rem 0' }}>
              {t('common.loading')}
            </div>
          )}
          {error && (
            <div className="label-mono" style={{ color: 'var(--rust)', padding: '2rem 0' }}>
              {t('pages.repos.loadingError')}
            </div>
          )}
          {repos && (
            <DataTable
              columns={columns}
              rows={repos}
              rowKey={(r) => r.id}
              emptyMessage={t('pages.repos.emptyMessage')}
            />
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
