import { type FormEvent, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useDeleteLlmKey, useLlmKeys, useRotateLlmKey, useUpsertLlmKey } from '../api/client.js';
import type { BYOKProvider } from '../api/types.js';
import { BYOK_PROVIDERS } from '../api/types.js';
import { ConfirmDialog } from '../components/confirm-dialog.js';
import { Hairline } from '../components/hairline.js';
import { StaggerContainer, StaggerItem } from '../components/page-transition.js';
import { SectionHeading } from '../components/section-heading.js';
import { ToastContainer, useToast } from '../components/toast.js';
import { UnsavedChangesDialog } from '../components/unsaved-changes-dialog.js';
import { useAuth } from '../contexts/auth-context.js';
import { useUnsavedChangesPrompt } from '../hooks/use-unsaved-changes-prompt.js';

// Map from provider value to i18n label key.
const PROVIDER_LABEL_KEYS: Record<BYOKProvider, string> = {
  anthropic: 'pages.byokKeys.providerAnthropicLabel',
  openai: 'pages.byokKeys.providerOpenaiLabel',
  'azure-openai': 'pages.byokKeys.providerAzureOpenaiLabel',
  google: 'pages.byokKeys.providerGoogleLabel',
  vertex: 'pages.byokKeys.providerVertexLabel',
  bedrock: 'pages.byokKeys.providerBedrockLabel',
  'openai-compatible': 'pages.byokKeys.providerOpenaiCompatibleLabel',
};

type ConfirmAction =
  | { kind: 'rotate'; provider: BYOKProvider }
  | { kind: 'remove'; provider: BYOKProvider };

const PRISTINE_PROVIDER: BYOKProvider = BYOK_PROVIDERS[0];
const PRISTINE_API_KEY = '';

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

const actionBtnStyle: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: '0.6875rem',
  fontWeight: 600,
  letterSpacing: '0.08em',
  color: 'var(--graphite)',
  border: '1px solid var(--hairline)',
  padding: '0.25rem 0.625rem',
  borderRadius: 'var(--radius)',
  transition: 'all var(--transition-fast)',
  backgroundColor: 'transparent',
  cursor: 'pointer',
};

export function ByokKeysPage() {
  const { t } = useTranslation();
  const { messages, toast, dismiss } = useToast();
  const { maxRole, legacy } = useAuth();
  // BYOK key management is admin-only.
  const canManageKeys = legacy || maxRole === 'admin';

  // Installation ID input state
  const [installationIdInput, setInstallationIdInput] = useState('');
  const [installationIdError, setInstallationIdError] = useState<string | null>(null);
  const [resolvedInstallationId, setResolvedInstallationId] = useState<number | null>(null);

  // Add/replace form state
  const [provider, setProvider] = useState<BYOKProvider>(PRISTINE_PROVIDER);
  const [apiKey, setApiKey] = useState(PRISTINE_API_KEY);
  const [showKey, setShowKey] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  // Confirm dialog state
  const [pendingAction, setPendingAction] = useState<ConfirmAction | null>(null);

  const installationIdInputId = useId();
  const installationIdErrorId = useId();
  const providerSelectId = useId();
  const apiKeyInputId = useId();

  const { data, isLoading, error: loadError } = useLlmKeys(resolvedInstallationId);
  const upsertMutation = useUpsertLlmKey();
  const rotateMutation = useRotateLlmKey();
  const deleteMutation = useDeleteLlmKey();

  // Dirty when apiKey field has content (provider alone is never "unsaved" since
  // it defaults to a valid value and is not typed by the user).
  const isDirty = !submitted && apiKey !== PRISTINE_API_KEY;

  const {
    isBlocked,
    confirm: confirmLeave,
    cancel: cancelLeave,
  } = useUnsavedChangesPrompt(isDirty);

  function resolveInstallationId() {
    setInstallationIdError(null);
    const trimmed = installationIdInput.trim();
    if (!trimmed) {
      setInstallationIdError(t('pages.byokKeys.validationInstallationIdRequired'));
      return;
    }
    const n = Number(trimmed);
    if (!Number.isInteger(n) || n <= 0 || String(n) !== trimmed) {
      setInstallationIdError(t('pages.byokKeys.validationInstallationIdInvalid'));
      return;
    }
    setResolvedInstallationId(n);
  }

  function handleInstallationIdKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault();
      resolveInstallationId();
    }
  }

  function handleAddKeySubmit(e: FormEvent) {
    e.preventDefault();

    if (!resolvedInstallationId) return;
    const trimmedKey = apiKey.trim();
    if (!trimmedKey) return;

    upsertMutation.mutate(
      { installationId: resolvedInstallationId, provider, apiKey: trimmedKey },
      {
        onSuccess: () => {
          // Clear form first, then mark submitted to suppress the unsaved guard.
          setApiKey(PRISTINE_API_KEY);
          setSubmitted(true);
          // Reset submitted on next tick so future edits are guarded again.
          setTimeout(() => setSubmitted(false), 0);
          setShowKey(false);
          toast(t('toast.llmKeySaved'), 'success');
        },
        onError: () => {
          toast(t('toast.llmKeySaveFailed'), 'error');
        },
      },
    );
  }

  function handleRotateClick(p: BYOKProvider) {
    setPendingAction({ kind: 'rotate', provider: p });
  }

  function handleRemoveClick(p: BYOKProvider) {
    setPendingAction({ kind: 'remove', provider: p });
  }

  function handleConfirm() {
    if (!pendingAction || !resolvedInstallationId) return;
    const { kind, provider: p } = pendingAction;
    setPendingAction(null);

    if (kind === 'rotate') {
      rotateMutation.mutate(
        { installationId: resolvedInstallationId, provider: p },
        {
          onSuccess: () => toast(t('toast.llmKeyRotated'), 'success'),
          onError: () => toast(t('toast.llmKeyRotateFailed'), 'error'),
        },
      );
    } else {
      deleteMutation.mutate(
        { installationId: resolvedInstallationId, provider: p },
        {
          onSuccess: () => toast(t('toast.llmKeyDeleted'), 'success'),
          onError: () => toast(t('toast.llmKeyDeleteFailed'), 'error'),
        },
      );
    }
  }

  function handleCancelConfirm() {
    setPendingAction(null);
  }

  const confirmTitle =
    pendingAction?.kind === 'rotate'
      ? t('dialog.confirmRotate.title')
      : t('dialog.confirmRemove.title');

  const confirmMessage =
    pendingAction?.kind === 'rotate'
      ? t('dialog.confirmRotate.message', {
          provider: pendingAction ? t(PROVIDER_LABEL_KEYS[pendingAction.provider]) : '',
        })
      : t('dialog.confirmRemove.message', {
          provider: pendingAction ? t(PROVIDER_LABEL_KEYS[pendingAction.provider]) : '',
        });

  const confirmLabel =
    pendingAction?.kind === 'rotate'
      ? t('dialog.confirmRotate.confirm')
      : t('dialog.confirmRemove.confirm');

  return (
    <>
      <UnsavedChangesDialog isBlocked={isBlocked} confirm={confirmLeave} cancel={cancelLeave} />

      <ConfirmDialog
        isOpen={pendingAction !== null}
        title={confirmTitle}
        message={confirmMessage}
        confirmLabel={confirmLabel}
        cancelLabel={
          pendingAction?.kind === 'rotate'
            ? t('dialog.confirmRotate.cancel')
            : t('dialog.confirmRemove.cancel')
        }
        tone="danger"
        onConfirm={handleConfirm}
        onCancel={handleCancelConfirm}
      />

      <ToastContainer messages={messages} onDismiss={dismiss} />

      <StaggerContainer>
        <StaggerItem>
          <SectionHeading
            title={t('pages.byokKeys.title')}
            subtitle={t('pages.byokKeys.subtitle')}
          />
        </StaggerItem>

        {/* Installation ID lookup */}
        <StaggerItem>
          <div style={{ maxWidth: '420px', marginBottom: '2rem' }}>
            <label htmlFor={installationIdInputId} style={labelStyle}>
              {t('pages.byokKeys.labelInstallationId')}
            </label>
            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start' }}>
              <div style={{ flex: 1 }}>
                <input
                  id={installationIdInputId}
                  type="text"
                  inputMode="numeric"
                  value={installationIdInput}
                  onChange={(e) => {
                    setInstallationIdInput(e.target.value);
                    setInstallationIdError(null);
                  }}
                  onKeyDown={handleInstallationIdKeyDown}
                  placeholder={t('pages.byokKeys.placeholderInstallationId')}
                  autoComplete="off"
                  style={inputStyle}
                  aria-describedby={installationIdError ? installationIdErrorId : undefined}
                  aria-invalid={installationIdError ? 'true' : undefined}
                />
                {installationIdError && (
                  <p
                    id={installationIdErrorId}
                    role="alert"
                    style={{
                      marginTop: '0.375rem',
                      fontFamily: 'var(--font-mono)',
                      fontSize: '0.625rem',
                      color: 'var(--rust)',
                    }}
                  >
                    {installationIdError}
                  </p>
                )}
              </div>
              <button
                type="button"
                onClick={resolveInstallationId}
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: '0.6875rem',
                  fontWeight: 700,
                  letterSpacing: '0.08em',
                  textTransform: 'uppercase',
                  color: 'var(--paper)',
                  backgroundColor: 'var(--ink)',
                  border: 'none',
                  padding: '0.625rem 1rem',
                  borderRadius: 'var(--radius)',
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                  transition: 'background-color var(--transition-fast)',
                }}
              >
                {t('common.save')}
              </button>
            </div>
          </div>
        </StaggerItem>

        {/* Key list */}
        {resolvedInstallationId === null && (
          <StaggerItem>
            <p className="label-mono" style={{ color: 'var(--graphite)' }}>
              {t('pages.byokKeys.noInstallationId')}
            </p>
          </StaggerItem>
        )}

        {resolvedInstallationId !== null && isLoading && (
          <StaggerItem>
            <p className="label-mono" style={{ color: 'var(--graphite)' }}>
              {t('common.loading')}
            </p>
          </StaggerItem>
        )}

        {resolvedInstallationId !== null && loadError && (
          <StaggerItem>
            <p className="label-mono" style={{ color: 'var(--rust)' }}>
              {t('pages.byokKeys.loadingError')}
            </p>
          </StaggerItem>
        )}

        {resolvedInstallationId !== null && data && (
          <StaggerItem>
            <div
              style={{
                border: '1px solid var(--hairline)',
                borderRadius: 'var(--radius)',
                overflow: 'hidden',
              }}
            >
              {/* Table header */}
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1fr auto auto',
                  gap: '0 1rem',
                  padding: '0.5rem 1rem',
                  backgroundColor: 'var(--bg-raised)',
                  borderBottom: '1px solid var(--hairline)',
                }}
              >
                <span className="label-mono" style={{ color: 'var(--graphite)' }}>
                  {t('pages.byokKeys.headerProvider')}
                </span>
                <span className="label-mono" style={{ color: 'var(--graphite)' }}>
                  {t('pages.byokKeys.headerStatus')}
                </span>
                <span className="label-mono" style={{ color: 'var(--graphite)' }}>
                  {t('pages.byokKeys.headerActions')}
                </span>
              </div>

              {/* Rows */}
              {data.keys.map((keyStatus, idx) => (
                <div key={keyStatus.provider}>
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '1fr auto auto',
                      gap: '0 1rem',
                      padding: '0.75rem 1rem',
                      alignItems: 'center',
                    }}
                  >
                    <span
                      style={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: '0.8125rem',
                        color: 'var(--fg)',
                      }}
                    >
                      {t(PROVIDER_LABEL_KEYS[keyStatus.provider])}
                    </span>
                    <span
                      style={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: '0.6875rem',
                        fontWeight: 600,
                        letterSpacing: '0.08em',
                        color: keyStatus.configured ? 'var(--moss)' : 'var(--graphite)',
                      }}
                    >
                      {keyStatus.configured
                        ? t('pages.byokKeys.statusConfigured')
                        : t('pages.byokKeys.statusNotConfigured')}
                    </span>
                    <div style={{ display: 'flex', gap: '0.5rem' }}>
                      {canManageKeys && (
                        <>
                          <button
                            type="button"
                            disabled={!keyStatus.configured}
                            onClick={() => handleRotateClick(keyStatus.provider)}
                            style={{
                              ...actionBtnStyle,
                              opacity: keyStatus.configured ? 1 : 0.35,
                              cursor: keyStatus.configured ? 'pointer' : 'not-allowed',
                            }}
                            aria-label={`${t('pages.byokKeys.actionRotate')} ${t(PROVIDER_LABEL_KEYS[keyStatus.provider])}`}
                          >
                            {t('pages.byokKeys.actionRotate')}
                          </button>
                          <button
                            type="button"
                            disabled={!keyStatus.configured}
                            onClick={() => handleRemoveClick(keyStatus.provider)}
                            style={{
                              ...actionBtnStyle,
                              color: keyStatus.configured ? 'var(--rust)' : 'var(--graphite)',
                              borderColor: keyStatus.configured ? 'var(--rust)' : 'var(--hairline)',
                              opacity: keyStatus.configured ? 1 : 0.35,
                              cursor: keyStatus.configured ? 'pointer' : 'not-allowed',
                            }}
                            aria-label={`${t('pages.byokKeys.actionRemove')} ${t(PROVIDER_LABEL_KEYS[keyStatus.provider])}`}
                          >
                            {t('pages.byokKeys.actionRemove')}
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                  {idx < data.keys.length - 1 && <Hairline />}
                </div>
              ))}
            </div>
          </StaggerItem>
        )}

        {/* Add / replace form — admin only */}
        {resolvedInstallationId !== null && canManageKeys && (
          <StaggerItem>
            <div style={{ maxWidth: '480px', marginTop: '2rem' }}>
              <h2
                style={{
                  fontFamily: 'var(--font-display)',
                  fontSize: '1.25rem',
                  fontWeight: 700,
                  letterSpacing: '-0.03em',
                  marginBottom: '1.5rem',
                }}
              >
                {t('pages.byokKeys.addKeyTitle')}
              </h2>
              <form onSubmit={handleAddKeySubmit} noValidate>
                {/* Provider select */}
                <div style={{ marginBottom: '1.5rem' }}>
                  <label htmlFor={providerSelectId} style={labelStyle}>
                    {t('pages.byokKeys.labelProvider')}
                  </label>
                  <select
                    id={providerSelectId}
                    value={provider}
                    onChange={(e) => setProvider(e.target.value as BYOKProvider)}
                    style={inputStyle}
                  >
                    {BYOK_PROVIDERS.map((p) => (
                      <option key={p} value={p}>
                        {t(PROVIDER_LABEL_KEYS[p])}
                      </option>
                    ))}
                  </select>
                </div>

                <Hairline style={{ marginBottom: '1.5rem' }} />

                {/* API key input */}
                <div style={{ marginBottom: '1.5rem' }}>
                  <label htmlFor={apiKeyInputId} style={labelStyle}>
                    {t('pages.byokKeys.labelApiKey')}
                  </label>
                  <div style={{ position: 'relative' }}>
                    <input
                      id={apiKeyInputId}
                      type={showKey ? 'text' : 'password'}
                      value={apiKey}
                      onChange={(e) => setApiKey(e.target.value)}
                      placeholder={t('pages.byokKeys.placeholderApiKey')}
                      autoComplete="off"
                      style={{
                        ...inputStyle,
                        paddingRight: '4.5rem',
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => setShowKey((prev) => !prev)}
                      aria-label={t('pages.byokKeys.ariaToggleKeyVisibility')}
                      style={{
                        position: 'absolute',
                        right: '0.5rem',
                        top: '50%',
                        transform: 'translateY(-50%)',
                        fontFamily: 'var(--font-mono)',
                        fontSize: '0.5625rem',
                        fontWeight: 600,
                        letterSpacing: '0.08em',
                        color: 'var(--graphite)',
                        border: '1px solid var(--hairline)',
                        padding: '0.2rem 0.4rem',
                        borderRadius: 'var(--radius)',
                        backgroundColor: 'var(--bg)',
                        cursor: 'pointer',
                      }}
                    >
                      {showKey ? t('pages.byokKeys.hideKey') : t('pages.byokKeys.showKey')}
                    </button>
                  </div>
                </div>

                {/* Submit */}
                <button
                  type="submit"
                  disabled={upsertMutation.isPending || !apiKey.trim()}
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: '0.6875rem',
                    fontWeight: 700,
                    letterSpacing: '0.08em',
                    textTransform: 'uppercase',
                    color: 'var(--paper)',
                    backgroundColor:
                      upsertMutation.isPending || !apiKey.trim() ? 'var(--graphite)' : 'var(--ink)',
                    border: 'none',
                    padding: '0.625rem 1.25rem',
                    borderRadius: 'var(--radius)',
                    cursor: upsertMutation.isPending || !apiKey.trim() ? 'not-allowed' : 'pointer',
                    transition: 'background-color var(--transition-fast)',
                  }}
                >
                  {upsertMutation.isPending ? t('common.saving') : t('pages.byokKeys.addKeySubmit')}
                </button>
              </form>
            </div>
          </StaggerItem>
        )}
      </StaggerContainer>
    </>
  );
}
