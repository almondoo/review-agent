import { useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { apiLogin, useAuthConfig } from '../api/client.js';
import { setSessionToken } from '../lib/session-token.js';

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
  boxSizing: 'border-box',
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

export function LoginPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const usernameId = useId();
  const passwordId = useId();
  const errorId = useId();
  const { data: authConfig } = useAuthConfig();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<'invalid_credentials' | 'legacy_mode' | null>(null);
  const [isPending, setIsPending] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setIsPending(true);

    try {
      const result = await apiLogin({ username, password });
      setSessionToken(result.token);
      // Invalidate /me so AuthProvider re-fetches with the new token.
      await qc.invalidateQueries({ queryKey: ['auth-me'] });
      void navigate('/', { replace: true });
    } catch (err) {
      if (err instanceof Error) {
        if (err.message.includes('404')) {
          setError('legacy_mode');
        } else {
          // 401 or anything else — don't leak whether the username exists.
          setError('invalid_credentials');
        }
      } else {
        setError('invalid_credentials');
      }
    } finally {
      setIsPending(false);
    }
  }

  return (
    <div
      style={{
        minHeight: '100dvh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '2rem',
        backgroundColor: 'var(--bg)',
      }}
    >
      <div style={{ width: '100%', maxWidth: '360px' }}>
        {/* Logo */}
        <div
          style={{
            fontFamily: 'var(--font-display)',
            fontSize: '1.125rem',
            fontWeight: 800,
            letterSpacing: '-0.04em',
            fontVariationSettings: "'opsz' 144, 'SOFT' 40",
            marginBottom: '2rem',
          }}
        >
          review-agent
        </div>

        <h1
          style={{
            fontFamily: 'var(--font-display)',
            fontSize: '1.5rem',
            fontWeight: 700,
            letterSpacing: '-0.03em',
            marginBottom: '0.5rem',
          }}
        >
          {t('pages.login.title')}
        </h1>
        <p className="label-mono" style={{ color: 'var(--graphite)', marginBottom: '2rem' }}>
          {t('pages.login.subtitle')}
        </p>

        <form
          onSubmit={(e) => {
            void handleSubmit(e);
          }}
          noValidate
          aria-describedby={error ? errorId : undefined}
        >
          {/* Username */}
          <div style={{ marginBottom: '1.25rem' }}>
            <label htmlFor={usernameId} style={labelStyle}>
              {t('pages.login.labelUsername')}
            </label>
            <input
              id={usernameId}
              type="text"
              value={username}
              onChange={(e) => {
                setUsername(e.target.value);
                setError(null);
              }}
              placeholder={t('pages.login.placeholderUsername')}
              autoComplete="username"
              required
              style={inputStyle}
              aria-invalid={error === 'invalid_credentials' ? 'true' : undefined}
            />
          </div>

          {/* Password */}
          <div style={{ marginBottom: '1.5rem' }}>
            <label htmlFor={passwordId} style={labelStyle}>
              {t('pages.login.labelPassword')}
            </label>
            <input
              id={passwordId}
              type="password"
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                setError(null);
              }}
              placeholder={t('pages.login.placeholderPassword')}
              autoComplete="current-password"
              required
              style={inputStyle}
              aria-invalid={error === 'invalid_credentials' ? 'true' : undefined}
            />
          </div>

          {/* Error message */}
          {error && (
            <p
              id={errorId}
              role="alert"
              style={{
                marginBottom: '1rem',
                fontFamily: 'var(--font-mono)',
                fontSize: '0.6875rem',
                color: 'var(--rust)',
              }}
            >
              {error === 'legacy_mode'
                ? t('pages.login.errorLegacyMode')
                : t('pages.login.errorInvalidCredentials')}
            </p>
          )}

          {/* Submit */}
          <button
            type="submit"
            disabled={isPending || !username.trim() || !password.trim()}
            style={{
              width: '100%',
              fontFamily: 'var(--font-mono)',
              fontSize: '0.6875rem',
              fontWeight: 700,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              color: 'var(--paper)',
              backgroundColor:
                isPending || !username.trim() || !password.trim()
                  ? 'var(--graphite)'
                  : 'var(--ink)',
              border: 'none',
              padding: '0.75rem 1.25rem',
              borderRadius: 'var(--radius)',
              cursor: isPending || !username.trim() || !password.trim() ? 'not-allowed' : 'pointer',
              transition: 'background-color var(--transition-fast)',
            }}
          >
            {isPending ? t('pages.login.submitting') : t('pages.login.submit')}
          </button>
        </form>

        {/* SSO button — shown only when OIDC is enabled server-side */}
        {authConfig?.oidcEnabled === true && (
          <div style={{ marginTop: '1.25rem' }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.75rem',
                marginBottom: '1rem',
              }}
            >
              <div style={{ flex: 1, height: '1px', backgroundColor: 'var(--hairline)' }} />
              <span
                className="label-mono"
                style={{ color: 'var(--graphite)', whiteSpace: 'nowrap' }}
              >
                {t('pages.login.ssoOr')}
              </span>
              <div style={{ flex: 1, height: '1px', backgroundColor: 'var(--hairline)' }} />
            </div>
            <button
              type="button"
              onClick={() => {
                window.location.href = '/api/auth/oidc/authorize';
              }}
              style={{
                width: '100%',
                fontFamily: 'var(--font-mono)',
                fontSize: '0.6875rem',
                fontWeight: 700,
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
                color: 'var(--ink)',
                backgroundColor: 'var(--bg-raised)',
                border: '1px solid var(--hairline)',
                padding: '0.75rem 1.25rem',
                borderRadius: 'var(--radius)',
                cursor: 'pointer',
                transition: 'background-color var(--transition-fast)',
              }}
            >
              {t('pages.login.ssoButton')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
