import { type ChangeEvent, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { usePutRepoPrompt, useRepoDetail, useRepoPrompt } from '../api/client.js';
import { Hairline } from '../components/hairline.js';
import { StaggerContainer, StaggerItem } from '../components/page-transition.js';
import { ToastContainer, useToast } from '../components/toast.js';
import { formatDateUtc, formatNumber } from '../lib/format.js';

const MAX_CHARS = 50_000;

export function RepoPromptPage() {
  const { id } = useParams<{ id: string }>();
  const safeId = id ?? '';
  const { toast, messages, dismiss } = useToast();

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

  // Warn on unload when dirty
  useEffect(() => {
    function handleBeforeUnload(e: BeforeUnloadEvent) {
      if (isDirty) {
        e.preventDefault();
        e.returnValue = '';
      }
    }
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [isDirty]);

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
          toast('[OK] Prompt saved successfully.', 'success');
        },
        onError: () => {
          toast('[FAIL] Failed to save prompt.', 'error');
        },
      },
    );
  }

  function handleDiscard() {
    setDraft(savedRef.current);
  }

  return (
    <>
      <ToastContainer messages={messages} onDismiss={dismiss} />
      <StaggerContainer style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        {/* Breadcrumb */}
        <StaggerItem>
          <div className="label-mono" style={{ color: 'var(--graphite)', marginBottom: '0.5rem' }}>
            <Link to="/repos" style={{ color: 'var(--graphite)' }}>
              Repos
            </Link>
            {' / '}
            <Link to={`/repos/${safeId}`} style={{ color: 'var(--graphite)' }}>
              {repo?.name ?? safeId}
            </Link>
            {' / Prompt'}
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
                System Prompt
              </h1>
              {isDirty && (
                <span
                  role="img"
                  title="Unsaved changes"
                  aria-label="Unsaved changes"
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
              {repo?.name ?? safeId} — Last updated{' '}
              {promptData?.updatedAt ? formatDateUtc(promptData.updatedAt) : 'Never'}
            </p>
          </div>
          <Hairline style={{ marginBottom: '1.5rem' }} />
        </StaggerItem>

        {/* Textarea */}
        <StaggerItem style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
          {isLoading ? (
            <div className="label-mono" style={{ color: 'var(--graphite)' }}>
              [LOADING...]
            </div>
          ) : (
            <textarea
              value={draft}
              onChange={handleChange}
              placeholder="Leave empty to inherit the default system prompt."
              spellCheck={false}
              aria-label="System prompt editor"
              style={{
                flex: 1,
                minHeight: '60vh',
                width: '100%',
                fontFamily: 'var(--font-mono)',
                fontSize: '0.875rem',
                lineHeight: 1.7,
                tabSize: 2,
                color: 'var(--fg)',
                backgroundColor: 'var(--bg-raised)',
                border: `1px solid ${isDirty ? 'var(--rust)' : 'var(--hairline)'}`,
                borderRadius: 'var(--radius)',
                padding: '1rem',
                resize: 'vertical',
                outline: 'none',
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
          disabled={putPrompt.isPending || !isDirty}
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: '0.6875rem',
            fontWeight: 700,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            color: 'var(--paper)',
            backgroundColor: putPrompt.isPending || !isDirty ? 'var(--graphite)' : 'var(--rust)',
            border: 'none',
            padding: '0.5rem 1.25rem',
            borderRadius: 'var(--radius)',
            cursor: putPrompt.isPending || !isDirty ? 'not-allowed' : 'pointer',
            transition: 'background-color var(--transition-fast)',
          }}
        >
          {putPrompt.isPending ? '[SAVING...]' : '[SAVE]'}
        </button>

        <button
          type="button"
          onClick={handleDiscard}
          disabled={!isDirty}
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: '0.6875rem',
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            color: isDirty ? 'var(--graphite)' : 'var(--graphite)',
            opacity: isDirty ? 1 : 0.4,
            cursor: isDirty ? 'pointer' : 'not-allowed',
            padding: '0.5rem 0',
          }}
        >
          [DISCARD]
        </button>

        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '1rem' }}>
          {isDirty && (
            <span className="label-mono" style={{ color: 'var(--rust)', fontSize: '0.5625rem' }}>
              [UNSAVED]
            </span>
          )}
          <span className="label-mono" style={{ color: 'var(--graphite)' }} aria-live="polite">
            {formatNumber(draft.length)} / {formatNumber(MAX_CHARS)} chars
          </span>
        </div>
      </div>
    </>
  );
}
