import { type FormEvent, useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { useCreateRepo } from '../api/client.js';
import type { Platform } from '../api/types.js';
import { Hairline } from '../components/hairline.js';
import { StaggerContainer, StaggerItem } from '../components/page-transition.js';
import { SectionHeading } from '../components/section-heading.js';
import { UnsavedChangesDialog } from '../components/unsaved-changes-dialog.js';
import { useUnsavedChangesPrompt } from '../hooks/use-unsaved-changes-prompt.js';

type PlatformOption = { value: Platform; labelKey: string };

const PLATFORM_OPTIONS: PlatformOption[] = [
  { value: 'github', labelKey: 'platforms.github' },
  { value: 'codecommit', labelKey: 'platforms.codecommit' },
];

// Pristine baseline: values the form starts with (before the user touches anything).
const PRISTINE_PLATFORM: Platform = 'github';
const PRISTINE_NAME = '';

export function ReposNewPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const createRepo = useCreateRepo();
  const [platform, setPlatform] = useState<Platform>(PRISTINE_PLATFORM);
  const [name, setName] = useState(PRISTINE_NAME);
  const [validationError, setValidationError] = useState<string | null>(null);
  // Track whether the form was successfully submitted so we skip the leave-guard
  // after a successful create+navigate sequence. Must be state (not ref) so that
  // useBlocker sees the updated value on the re-render before navigate() runs.
  const [submitted, setSubmitted] = useState(false);
  const platformId = useId();
  const nameId = useId();
  const nameErrorId = useId();

  // Dirty when either field differs from pristine AND the form has not been submitted.
  const isDirty = !submitted && (platform !== PRISTINE_PLATFORM || name !== PRISTINE_NAME);

  const {
    isBlocked,
    confirm: confirmLeave,
    cancel: cancelLeave,
  } = useUnsavedChangesPrompt(isDirty);

  // Navigate after the submitted state update settles so useBlocker sees isDirty=false.
  useEffect(() => {
    if (submitted) {
      navigate('/repos');
    }
  }, [submitted, navigate]);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setValidationError(null);

    const trimmed = name.trim();
    if (!trimmed) {
      setValidationError(t('validation.repoNameRequired'));
      return;
    }
    if (!/^[a-zA-Z0-9._\-/]+$/.test(trimmed)) {
      setValidationError(t('validation.repoNameInvalid'));
      return;
    }

    createRepo.mutate(
      { platform, name: trimmed },
      {
        onSuccess: () => {
          // Setting state triggers a re-render; the useEffect above navigates
          // after the re-render so useBlocker sees the updated isDirty=false.
          setSubmitted(true);
        },
      },
    );
  }

  const inputStyle: React.CSSProperties = {
    display: 'block',
    width: '100%',
    padding: '0.625rem 0.75rem',
    fontFamily: 'var(--font-mono)',
    fontSize: '0.875rem',
    backgroundColor: 'var(--bg-raised)',
    border: '1px solid var(--hairline)',
    borderRadius: 'var(--radius)',
    color: 'var(--fg)',
    outline: 'none',
    transition: 'border-color var(--transition-fast)',
  };

  const labelStyle: React.CSSProperties = {
    display: 'block',
    fontFamily: 'var(--font-mono)',
    fontSize: '0.625rem',
    fontWeight: 600,
    letterSpacing: '0.1em',
    textTransform: 'uppercase',
    color: 'var(--graphite)',
    marginBottom: '0.5rem',
  };

  return (
    <>
      <UnsavedChangesDialog isBlocked={isBlocked} confirm={confirmLeave} cancel={cancelLeave} />
      <StaggerContainer>
        <StaggerItem>
          <SectionHeading
            title={t('pages.reposNew.title')}
            subtitle={t('pages.reposNew.subtitle')}
          />
        </StaggerItem>

        <StaggerItem>
          <div style={{ maxWidth: '480px' }}>
            <form onSubmit={handleSubmit} noValidate>
              {/* Platform */}
              <div style={{ marginBottom: '1.5rem' }}>
                <label htmlFor={platformId} style={labelStyle}>
                  {t('pages.reposNew.labelPlatform')}
                </label>
                <select
                  id={platformId}
                  value={platform}
                  onChange={(e) => setPlatform(e.target.value as Platform)}
                  style={inputStyle}
                >
                  {PLATFORM_OPTIONS.map((p) => (
                    <option key={p.value} value={p.value}>
                      {t(p.labelKey)}
                    </option>
                  ))}
                </select>
              </div>

              <Hairline style={{ marginBottom: '1.5rem' }} />

              {/* Repository name */}
              <div style={{ marginBottom: '1.5rem' }}>
                <label htmlFor={nameId} style={labelStyle}>
                  {t('pages.reposNew.labelRepoName')}
                </label>
                <input
                  id={nameId}
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={
                    platform === 'github'
                      ? t('common.repoNamePlaceholderGithub')
                      : t('common.repoNamePlaceholderCodecommit')
                  }
                  autoComplete="off"
                  style={inputStyle}
                  aria-describedby={validationError ? nameErrorId : undefined}
                  aria-invalid={validationError ? 'true' : undefined}
                />
                {validationError && (
                  <p
                    id={nameErrorId}
                    role="alert"
                    style={{
                      marginTop: '0.375rem',
                      fontFamily: 'var(--font-mono)',
                      fontSize: '0.625rem',
                      color: 'var(--rust)',
                    }}
                  >
                    {t('pages.reposNew.errorPrefix')}
                    {validationError}
                  </p>
                )}
              </div>

              {/* Mutation error */}
              {createRepo.isError && (
                <p
                  role="alert"
                  style={{
                    marginBottom: '1rem',
                    fontFamily: 'var(--font-mono)',
                    fontSize: '0.625rem',
                    color: 'var(--rust)',
                  }}
                >
                  {t('pages.reposNew.mutationError')}
                </p>
              )}

              {/* Actions */}
              <div style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
                <button
                  type="submit"
                  disabled={createRepo.isPending}
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: '0.6875rem',
                    fontWeight: 700,
                    letterSpacing: '0.08em',
                    textTransform: 'uppercase',
                    color: 'var(--paper)',
                    backgroundColor: createRepo.isPending ? 'var(--graphite)' : 'var(--ink)',
                    border: 'none',
                    padding: '0.625rem 1.25rem',
                    borderRadius: 'var(--radius)',
                    cursor: createRepo.isPending ? 'not-allowed' : 'pointer',
                    transition: 'background-color var(--transition-fast)',
                  }}
                >
                  {createRepo.isPending ? t('common.saving') : t('common.addRepoSubmit')}
                </button>

                <button
                  type="button"
                  onClick={() => navigate('/repos')}
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: '0.6875rem',
                    letterSpacing: '0.08em',
                    textTransform: 'uppercase',
                    color: 'var(--graphite)',
                    padding: '0.625rem 0',
                  }}
                >
                  {t('common.cancel')}
                </button>
              </div>
            </form>
          </div>
        </StaggerItem>
      </StaggerContainer>
    </>
  );
}
