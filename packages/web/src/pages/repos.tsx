import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useDeleteRepo, usePatchRepo, useRepos } from '../api/client.js';
import type { RepoSummary } from '../api/types.js';
import type { Column } from '../components/data-table.js';
import { DataTable } from '../components/data-table.js';
import { Hairline } from '../components/hairline.js';
import { StaggerContainer, StaggerItem } from '../components/page-transition.js';
import { PlatformBadge } from '../components/platform-badge.js';
import { SectionHeading } from '../components/section-heading.js';
import { StatusBadge } from '../components/status-badge.js';
import { formatRelativeDate } from '../lib/format.js';

export function ReposPage() {
  const { data: repos, isLoading, error } = useRepos();
  const patchRepo = usePatchRepo();
  const deleteRepo = useDeleteRepo();
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const columns: Column<RepoSummary>[] = [
    {
      key: 'platform',
      header: 'Platform',
      width: '100px',
      render: (row) => <PlatformBadge platform={row.platform} />,
    },
    {
      key: 'name',
      header: 'Repository',
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
      header: 'Status',
      width: '80px',
      render: (row) => <StatusBadge status={row.lastOutcome ?? 'queued'} />,
    },
    {
      key: 'lastReview',
      header: 'Last Review',
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
      header: 'Enabled',
      width: '80px',
      align: 'center',
      render: (row) => (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            patchRepo.mutate({ id: row.id, body: { enabled: !row.enabled } });
          }}
          aria-label={`${row.enabled ? 'Disable' : 'Enable'} ${row.name}`}
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
          }}
        >
          {row.enabled ? '[ON]' : '[OFF]'}
        </button>
      ),
    },
    {
      key: 'delete',
      header: '',
      width: '60px',
      align: 'right',
      render: (row) =>
        confirmDelete === row.id ? (
          <span style={{ display: 'flex', gap: '0.25rem', justifyContent: 'flex-end' }}>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                deleteRepo.mutate(row.id);
                setConfirmDelete(null);
              }}
              className="label-mono"
              style={{ color: 'var(--rust)' }}
              aria-label={`Confirm delete ${row.name}`}
            >
              [CONFIRM]
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setConfirmDelete(null);
              }}
              className="label-mono"
              style={{ color: 'var(--graphite)' }}
              aria-label="Cancel delete"
            >
              [CANCEL]
            </button>
          </span>
        ) : (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setConfirmDelete(row.id);
            }}
            className="label-mono"
            style={{ color: 'var(--graphite)', opacity: 0.4 }}
            aria-label={`Delete ${row.name}`}
          >
            [DEL]
          </button>
        ),
    },
  ];

  return (
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
            title="Repos"
            {...(repos ? { subtitle: `${repos.length} connected repositories` } : {})}
          />
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
            [+ ADD REPO]
          </Link>
        </div>
      </StaggerItem>

      <StaggerItem>
        <Hairline style={{ marginBottom: '0' }} />
      </StaggerItem>

      <StaggerItem>
        {isLoading && (
          <div className="label-mono" style={{ color: 'var(--graphite)', padding: '2rem 0' }}>
            [LOADING...]
          </div>
        )}
        {error && (
          <div className="label-mono" style={{ color: 'var(--rust)', padding: '2rem 0' }}>
            [ERROR] Failed to load repositories.
          </div>
        )}
        {repos && (
          <DataTable
            columns={columns}
            rows={repos}
            rowKey={(r) => r.id}
            emptyMessage="[EMPTY] — No repositories connected."
          />
        )}
      </StaggerItem>
    </StaggerContainer>
  );
}
