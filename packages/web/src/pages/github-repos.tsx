import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useBulkCreateRepos, useInstallationRepos } from '../api/client.js';
import type { InstallationRepo } from '../api/types.js';
import { Hairline } from '../components/hairline.js';
import { StaggerContainer, StaggerItem } from '../components/page-transition.js';
import { SectionHeading } from '../components/section-heading.js';
import { ToastContainer, useToast } from '../components/toast.js';
import { UnsavedChangesDialog } from '../components/unsaved-changes-dialog.js';
import { useUnsavedChangesPrompt } from '../hooks/use-unsaved-changes-prompt.js';

const badgeStyle: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: '0.5625rem',
  fontWeight: 700,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  padding: '0.125rem 0.375rem',
  borderRadius: 'var(--radius)',
  border: '1px solid var(--hairline)',
  color: 'var(--graphite)',
};

type RepoRowProps = {
  repo: InstallationRepo;
  selected: boolean;
  onToggle: (id: number) => void;
};

function RepoRow({ repo, selected, onToggle }: RepoRowProps) {
  const { t } = useTranslation();
  const isDisabled = repo.registered;
  return (
    <label
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '0.75rem',
        padding: '0.625rem 0',
        cursor: isDisabled ? 'default' : 'pointer',
        opacity: isDisabled ? 0.5 : 1,
      }}
    >
      <input
        type="checkbox"
        checked={isDisabled || selected}
        disabled={isDisabled}
        onChange={() => {
          if (!isDisabled) onToggle(repo.id);
        }}
        aria-label={repo.fullName}
      />
      <span
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: '0.8125rem',
          color: 'var(--fg)',
          flex: 1,
        }}
      >
        {repo.fullName}
      </span>
      {repo.private && <span style={badgeStyle}>{t('pages.githubRepos.badgePrivate')}</span>}
      {repo.registered && <span style={badgeStyle}>{t('pages.githubRepos.badgeRegistered')}</span>}
    </label>
  );
}

export function GithubReposPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const rawId = searchParams.get('installation_id');
  const installationId = rawId !== null && rawId !== '' ? Number(rawId) : null;

  const { messages, toast, dismiss } = useToast();
  const [filter, setFilter] = useState('');
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<number>>(new Set());
  const [bulkErrors, setBulkErrors] = useState<{ name: string; message: string }[]>([]);
  const [submitted, setSubmitted] = useState(false);

  const isDirty = !submitted && selectedIds.size > 0;
  const {
    isBlocked,
    confirm: confirmLeave,
    cancel: cancelLeave,
  } = useUnsavedChangesPrompt(isDirty);

  const {
    data,
    isLoading,
    error: loadError,
  } = useInstallationRepos(Number.isNaN(installationId) ? null : installationId);
  const bulkCreate = useBulkCreateRepos();

  // Redirect if installation_id is absent or not a positive integer.
  useEffect(() => {
    if (installationId === null || Number.isNaN(installationId) || installationId <= 0) {
      navigate('/integrations', { replace: true });
    }
  }, [installationId, navigate]);

  if (installationId === null || Number.isNaN(installationId) || installationId <= 0) {
    return null;
  }

  // installationId is a positive number from this point on (narrowed by the guard above).
  const safeInstallationId: number = installationId;

  const repos = data?.repos ?? [];
  const filtered = filter.trim()
    ? repos.filter((r) => r.fullName.toLowerCase().includes(filter.trim().toLowerCase()))
    : repos;

  const unregisteredFiltered = filtered.filter((r) => !r.registered);
  const allUnregisteredSelected =
    unregisteredFiltered.length > 0 && unregisteredFiltered.every((r) => selectedIds.has(r.id));

  function toggleRepo(id: number) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  function toggleSelectAll() {
    if (allUnregisteredSelected) {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        for (const r of unregisteredFiltered) {
          next.delete(r.id);
        }
        return next;
      });
    } else {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        for (const r of unregisteredFiltered) {
          next.add(r.id);
        }
        return next;
      });
    }
  }

  function handleSubmit() {
    const names = repos
      .filter((r) => !r.registered && selectedIds.has(r.id))
      .map((r) => r.fullName);
    if (names.length === 0) return;

    bulkCreate.mutate(
      { installationId: safeInstallationId, names },
      {
        onSuccess: (result) => {
          setBulkErrors(result.errors);
          if (result.created.length > 0 && result.errors.length === 0) {
            setSubmitted(true);
            toast(t('toast.reposRegistered'), 'success');
            navigate('/repos');
          } else if (result.created.length > 0) {
            toast(t('toast.reposRegistered'), 'success');
          }
          if (result.errors.length > 0) {
            toast(t('toast.reposPartialFailure'), 'error');
          }
        },
        onError: () => {
          toast(t('toast.reposRegisterFailed'), 'error');
        },
      },
    );
  }

  return (
    <>
      <UnsavedChangesDialog isBlocked={isBlocked} confirm={confirmLeave} cancel={cancelLeave} />
      <ToastContainer messages={messages} onDismiss={dismiss} />
      <StaggerContainer>
        <StaggerItem>
          <SectionHeading
            title={t('pages.githubRepos.title')}
            subtitle={t('pages.githubRepos.subtitle', { installationId: safeInstallationId })}
          />
        </StaggerItem>

        {isLoading && (
          <StaggerItem>
            <div className="label-mono" style={{ color: 'var(--graphite)' }}>
              {t('common.loading')}
            </div>
          </StaggerItem>
        )}

        {loadError && (
          <StaggerItem>
            <div className="label-mono" style={{ color: 'var(--rust)' }}>
              {t('pages.githubRepos.loadingError')}
            </div>
          </StaggerItem>
        )}

        {bulkErrors.length > 0 && (
          <StaggerItem>
            <div
              role="alert"
              style={{
                padding: '0.75rem 1rem',
                border: '1px solid var(--rust)',
                borderRadius: 'var(--radius)',
                fontFamily: 'var(--font-mono)',
                fontSize: '0.75rem',
                color: 'var(--rust)',
                marginBottom: '0.5rem',
              }}
            >
              <p style={{ marginBottom: '0.375rem' }}>
                {t('pages.githubRepos.partialErrorHeading')}
              </p>
              <ul style={{ paddingLeft: '1rem', margin: 0 }}>
                {bulkErrors.map((e) => (
                  <li key={e.name}>{e.name}</li>
                ))}
              </ul>
            </div>
          </StaggerItem>
        )}

        {data && (
          <StaggerItem>
            {/* Filter input */}
            <div style={{ marginBottom: '1rem' }}>
              <input
                type="search"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder={t('pages.githubRepos.filterPlaceholder')}
                aria-label={t('pages.githubRepos.filterAriaLabel')}
                style={{
                  display: 'block',
                  width: '100%',
                  maxWidth: '360px',
                  padding: '0.5rem 0.75rem',
                  fontFamily: 'var(--font-mono)',
                  fontSize: '0.8125rem',
                  backgroundColor: 'var(--bg-raised)',
                  border: '1px solid var(--hairline)',
                  borderRadius: 'var(--radius)',
                  color: 'var(--fg)',
                  outline: 'none',
                }}
              />
            </div>

            {/* Select-all toggle */}
            {unregisteredFiltered.length > 0 && (
              <div style={{ marginBottom: '0.5rem' }}>
                <label
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.75rem',
                    cursor: 'pointer',
                    fontFamily: 'var(--font-mono)',
                    fontSize: '0.6875rem',
                    fontWeight: 700,
                    letterSpacing: '0.08em',
                    textTransform: 'uppercase',
                    color: 'var(--graphite)',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={allUnregisteredSelected}
                    onChange={toggleSelectAll}
                    aria-label={t('pages.githubRepos.selectAll')}
                  />
                  {t('pages.githubRepos.selectAll')}
                </label>
              </div>
            )}

            <Hairline style={{ marginBottom: '0.5rem' }} />

            {filtered.length === 0 ? (
              <p className="label-mono" style={{ color: 'var(--graphite)' }}>
                {t('pages.githubRepos.emptyMessage')}
              </p>
            ) : (
              <div>
                {filtered.map((repo) => (
                  <RepoRow
                    key={repo.id}
                    repo={repo}
                    selected={selectedIds.has(repo.id)}
                    onToggle={toggleRepo}
                  />
                ))}
              </div>
            )}

            <Hairline style={{ margin: '1rem 0' }} />

            <div style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
              <button
                type="button"
                disabled={selectedIds.size === 0 || bulkCreate.isPending}
                onClick={handleSubmit}
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: '0.6875rem',
                  fontWeight: 700,
                  letterSpacing: '0.08em',
                  textTransform: 'uppercase',
                  color: 'var(--paper)',
                  backgroundColor:
                    selectedIds.size === 0 || bulkCreate.isPending
                      ? 'var(--graphite)'
                      : 'var(--ink)',
                  border: 'none',
                  padding: '0.625rem 1.25rem',
                  borderRadius: 'var(--radius)',
                  cursor:
                    selectedIds.size === 0 || bulkCreate.isPending ? 'not-allowed' : 'pointer',
                  transition: 'background-color var(--transition-fast)',
                }}
              >
                {bulkCreate.isPending ? t('common.saving') : t('pages.githubRepos.addReposButton')}
              </button>

              <button
                type="button"
                onClick={() => navigate('/integrations')}
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: '0.6875rem',
                  letterSpacing: '0.08em',
                  textTransform: 'uppercase',
                  color: 'var(--graphite)',
                  padding: '0.625rem 0',
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                }}
              >
                {t('common.cancel')}
              </button>
            </div>
          </StaggerItem>
        )}
      </StaggerContainer>
    </>
  );
}
