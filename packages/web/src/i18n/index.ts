import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './en.json';
import ja from './ja.json';

export const LANG_STORAGE_KEY = 'review-agent-dashboard-lang';
export type SupportedLang = 'ja' | 'en';

/**
 * Resolve the initial UI language:
 * 1. Persisted value from localStorage (highest priority).
 * 2. navigator.language starts with 'ja' → 'ja'; anything else → 'en'.
 *
 * The resolved language is persisted to localStorage so subsequent
 * loads use the stored value.
 *
 * Note: 'ja' is also the i18next fallbackLng (used when a translation key
 * is missing), but that is independent of this detection logic. The
 * detection default for a non-Japanese navigator is 'en', not 'ja'.
 */
export function resolveInitialLanguage(): SupportedLang {
  const stored = localStorage.getItem(LANG_STORAGE_KEY);
  if (stored === 'ja' || stored === 'en') {
    return stored;
  }

  const nav = typeof navigator !== 'undefined' ? navigator.language : '';
  const resolved: SupportedLang = nav.startsWith('ja') ? 'ja' : 'en';
  localStorage.setItem(LANG_STORAGE_KEY, resolved);
  return resolved;
}

const initialLang = resolveInitialLanguage();

void i18n.use(initReactI18next).init({
  resources: {
    ja: { translation: ja },
    en: { translation: en },
  },
  lng: initialLang,
  fallbackLng: 'ja',
  interpolation: {
    escapeValue: false,
  },
});

export default i18n;
