import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/auth-context.js';
import { LANG_STORAGE_KEY } from '../i18n/index.js';
import { Hairline } from './hairline.js';

type Theme = 'light' | 'dark' | 'system';

function getEffectiveTheme(theme: Theme): 'light' | 'dark' {
  if (theme === 'system') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return theme;
}

function formatTimestamp(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}.${m}.${d}`;
}

export function Header() {
  const { t, i18n } = useTranslation();
  const { legacy, authenticated, principal, logout } = useAuth();
  const [theme, setTheme] = useState<Theme>('system');
  const [timestamp] = useState(formatTimestamp);

  useEffect(() => {
    const saved = localStorage.getItem('ra-theme') as Theme | null;
    if (saved) setTheme(saved);
  }, []);

  useEffect(() => {
    const effective = getEffectiveTheme(theme);
    document.documentElement.dataset.theme = effective;
    if (theme !== 'system') {
      localStorage.setItem('ra-theme', theme);
    } else {
      localStorage.removeItem('ra-theme');
    }
  }, [theme]);

  function toggleTheme() {
    setTheme((prev) => {
      if (prev === 'system' || prev === 'light') return 'dark';
      return 'light';
    });
  }

  function toggleLanguage() {
    const next = i18n.language === 'ja' ? 'en' : 'ja';
    void i18n.changeLanguage(next);
    localStorage.setItem(LANG_STORAGE_KEY, next);
    document.documentElement.lang = next;
  }

  const effectiveTheme = getEffectiveTheme(theme);
  const isJa = i18n.language === 'ja';

  return (
    <header
      style={{
        height: 'var(--header-height)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '0 1.5rem',
        position: 'sticky',
        top: 0,
        zIndex: 100,
        backgroundColor: 'var(--bg)',
        borderBottom: '1px solid var(--hairline)',
      }}
    >
      {/* Logo */}
      <div
        style={{
          fontFamily: 'var(--font-display)',
          fontSize: '1.125rem',
          fontWeight: 800,
          letterSpacing: '-0.04em',
          fontVariationSettings: "'opsz' 144, 'SOFT' 40",
        }}
      >
        review-agent
      </div>

      {/* Right: user info + logout + timestamp + lang toggle + theme toggle */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '1.5rem' }}>
        {/* Logged-in username (session mode only) */}
        {authenticated && !legacy && principal && (
          <>
            <span
              className="label-mono"
              style={{ color: 'var(--graphite)' }}
              title={t('header.loggedInAs', { username: principal.username })}
            >
              {principal.username}
            </span>
            <Hairline vertical style={{ height: '20px' }} />
          </>
        )}

        {/* Logout button (session mode only) */}
        {authenticated && !legacy && (
          <>
            <button
              type="button"
              onClick={() => {
                void logout();
              }}
              aria-label={t('header.logout')}
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: '0.625rem',
                fontWeight: 600,
                letterSpacing: '0.1em',
                textTransform: 'uppercase',
                color: 'var(--graphite)',
                padding: '0.25rem 0.5rem',
                border: '1px solid var(--hairline)',
                borderRadius: 'var(--radius)',
                transition: 'color var(--transition-fast), border-color var(--transition-fast)',
                cursor: 'pointer',
                backgroundColor: 'transparent',
              }}
            >
              {t('header.logoutLabel')}
            </button>
            <Hairline vertical style={{ height: '20px' }} />
          </>
        )}
        {/* Timestamp stamp */}
        <span
          role="img"
          className="label-mono"
          style={{ color: 'var(--graphite)' }}
          aria-label={t('header.currentDate')}
        >
          [{timestamp} — WAVE 17]
        </span>

        <Hairline vertical style={{ height: '20px' }} />

        {/* Language toggle */}
        <button
          type="button"
          onClick={toggleLanguage}
          aria-label={t('header.switchLang')}
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: '0.625rem',
            fontWeight: 600,
            letterSpacing: '0.1em',
            textTransform: 'uppercase',
            color: 'var(--graphite)',
            padding: '0.25rem 0.5rem',
            border: '1px solid var(--hairline)',
            borderRadius: 'var(--radius)',
            transition: 'color var(--transition-fast), border-color var(--transition-fast)',
          }}
        >
          {isJa ? '[EN]' : '[JA]'}
        </button>

        <Hairline vertical style={{ height: '20px' }} />

        {/* Dark mode toggle */}
        <button
          type="button"
          onClick={toggleTheme}
          aria-label={
            effectiveTheme === 'dark' ? t('header.switchToLight') : t('header.switchToDark')
          }
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: '0.625rem',
            fontWeight: 600,
            letterSpacing: '0.1em',
            textTransform: 'uppercase',
            color: 'var(--graphite)',
            padding: '0.25rem 0.5rem',
            border: '1px solid var(--hairline)',
            borderRadius: 'var(--radius)',
            transition: 'color var(--transition-fast), border-color var(--transition-fast)',
          }}
        >
          {effectiveTheme === 'dark' ? t('header.light') : t('header.dark')}
        </button>
      </div>
    </header>
  );
}
