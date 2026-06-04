import { type ChangeEvent, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { usePutRepoPrompt, useRepoDetail, useRepoPrompt } from '../api/client.js';
import { Hairline } from '../components/hairline.js';
import { StaggerContainer, StaggerItem } from '../components/page-transition.js';
import { ToastContainer, useToast } from '../components/toast.js';
import { UnsavedChangesDialog } from '../components/unsaved-changes-dialog.js';
import { useAuth } from '../contexts/auth-context.js';
import { useUnsavedChangesPrompt } from '../hooks/use-unsaved-changes-prompt.js';
import { formatDateUtc, formatNumber } from '../lib/format.js';

const MAX_CHARS = 50_000;

export function RepoPromptPage() {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const safeId = id ?? '';
  const { toast, messages, dismiss } = useToast();
  const { maxRole, legacy } = useAuth();
  // Prompt editing requires editor or admin role.
  const canEdit = legacy || maxRole === 'editor' || maxRole === 'admin';

  const { data: repo } = useRepoDetail(safeId);
  const { data: promptData, isLoading } = useRepoPrompt(safeId);
  const putPrompt = usePutRepoPrompt();

  const [draft, setDraft] = useState('');
  const [initialized, setInitialized] = useState(false);
  const savedRef = useRef('');

  // Initialize draft once data loads
  useEffect(() => {
    if (promptData && !initialized) {
      setDraft(promptData.systemPrompt);
      savedRef.current = promptData.systemPrompt;
      setInitialized(true);
    }
  }, [promptData, initialized]);

  const isDirty = draft !== savedRef.current;

  const {
    isBlocked,
    confirm: confirmLeave,
    cancel: cancelLeave,
  } = useUnsavedChangesPrompt(isDirty);

  function handleChange(e: ChangeEvent<HTMLTextAreaElement>) {
    const val = e.target.value;
    if (val.length <= MAX_CHARS) setDraft(val);
  }

  function handleSave() {
    if (putPrompt.isPending) return;
    putPrompt.mutate(
      { id: safeId, body: { systemPrompt: draft } },
      {
        onSuccess: () => {
          savedRef.current = draft;
          toast(t('toast.promptSaved'), 'success');
        },
        onError: () => {
          toast(t('toast.promptFailed'), 'error');
        },
      },
    );
  }

  function handleDiscard() {
    setDraft(savedRef.current);
  }

  return (
    <>
      <UnsavedChangesDialog isBlocked={isBlocked} confirm={confirmLeave} cancel={cancelLeave} />
      <ToastContainer messages={messages} onDismiss={dismiss} />
      <StaggerContainer style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        {/* Breadcrumb */}
        <StaggerItem>
          <div className="label-mono" style={{ color: 'var(--graphite)', marginBottom: '0.5rem' }}>
            <Link to="/repos" style={{ color: 'var(--graphite)' }}>
              {t('pages.repoPrompt.repos')}
            </Link>
            {' / '}
            <Link to={`/repos/${safeId}`} style={{ color: 'var(--graphite)' }}>
              {repo?.name ?? safeId}
            </Link>{' '}
            {t('pages.repoPrompt.breadcrumbPrompt')}
          </div>
        </StaggerItem>

        {/* Header */}
        <StaggerItem>
          <div style={{ marginBottom: '0.5rem' }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: '1rem' }}>
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
                {t('pages.repoPrompt.title')}
              </h1>
              {isDirty && (
                <span
                  role="img"
                  title={t('dialog.unsavedChanges.title')}
                  aria-label={t('dialog.unsavedChanges.title')}
                  style={{
                    width: '8px',
                    height: '8px',
                    borderRadius: '50%',
                    backgroundColor: 'var(--rust)',
                    display: 'inline-block',
                    flexShrink: 0,
                  }}
                />
              )}
            </div>
            <p className="label-mono" style={{ color: 'var(--graphite)', marginTop: '0.375rem' }}>
              {repo?.name ?? safeId} — {t('pages.repoPrompt.lastUpdated')}{' '}
              {promptData?.updatedAt
                ? formatDateUtc(promptData.updatedAt)
                : t('pages.repoPrompt.never')}
            </p>
          </div>
          <Hairline style={{ marginBottom: '1.5rem' }} />
        </StaggerItem>

        {/* Textarea */}
        <StaggerItem style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
          {isLoading ? (
            <div className="label-mono" style={{ color: 'var(--graphite)' }}>
              {t('common.loading')}
            </div>
          ) : (
            <textarea
              value={draft}
              onChange={handleChange}
              disabled={!canEdit}
              readOnly={!canEdit}
              placeholder={t('pages.repoPrompt.placeholder')}
              spellCheck={false}
              aria-label={t('pages.repoPrompt.editorLabel')}
              style={{
                flex: 1,
                minHeight: '60vh',
                width: '100%',
                fontFamily: 'var(--font-mono)',
                fontSize: '0.875rem',
                lineHeight: 1.7,
                tabSize: 2,
                color: 'var(--fg)',
                backgroundColor: canEdit ? 'var(--bg-raised)' : 'var(--bg)',
                border: `1px solid ${isDirty ? 'var(--rust)' : 'var(--hairline)'}`,
                borderRadius: 'var(--radius)',
                padding: '1rem',
                resize: canEdit ? 'vertical' : 'none',
                outline: 'none',
                cursor: canEdit ? undefined : 'not-allowed',
                opacity: canEdit ? 1 : 0.7,
                transition: 'border-color var(--transition-fast)',
              }}
            />
          )}
        </StaggerItem>
      </StaggerContainer>

      {/* Sticky bottom bar */}
      <div
        style={{
          position: 'sticky',
          bottom: 0,
          backgroundColor: 'var(--bg)',
          borderTop: '1px solid var(--hairline)',
          padding: '0.875rem 2rem',
          display: 'flex',
          alignItems: 'center',
          gap: '1rem',
          marginLeft: '-2rem',
          marginRight: '-2rem',
          zIndex: 50,
        }}
      >
        <button
          type="button"
          onClick={handleSave}
          disabled={putPrompt.isPending || !isDirty || !canEdit}
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: '0.6875rem',
            fontWeight: 700,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            color: 'var(--paper)',
            backgroundColor:
              putPrompt.isPending || !isDirty || !canEdit ? 'var(--graphite)' : 'var(--rust)',
            border: 'none',
            padding: '0.5rem 1.25rem',
            borderRadius: 'var(--radius)',
            cursor: putPrompt.isPending || !isDirty || !canEdit ? 'not-allowed' : 'pointer',
            transition: 'background-color var(--transition-fast)',
          }}
        >
          {putPrompt.isPending ? t('common.saving') : t('common.save')}
        </button>

        <button
          type="button"
          onClick={handleDiscard}
          disabled={!isDirty || !canEdit}
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: '0.6875rem',
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            color: 'var(--graphite)',
            opacity: isDirty && canEdit ? 1 : 0.4,
            cursor: isDirty && canEdit ? 'pointer' : 'not-allowed',
            padding: '0.5rem 0',
          }}
        >
          {t('common.discard')}
        </button>

        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '1rem' }}>
          {isDirty && (
            <span className="label-mono" style={{ color: 'var(--rust)', fontSize: '0.5625rem' }}>
              {t('common.unsaved')}
            </span>
          )}
          <span className="label-mono" style={{ color: 'var(--graphite)' }} aria-live="polite">
            {formatNumber(draft.length)} / {formatNumber(MAX_CHARS)} {t('pages.repoPrompt.chars')}
          </span>
        </div>
      </div>
    </>
  );
}
