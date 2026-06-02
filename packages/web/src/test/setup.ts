import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { afterEach, beforeAll } from 'vitest';
import en from '../i18n/en.json';
import ja from '../i18n/ja.json';

// jsdom does not implement window.matchMedia. Provide a minimal stub so that
// components calling it (e.g. Header's getEffectiveTheme) render without error.
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }),
});

// Initialize i18n in ENGLISH for all tests so existing English-literal assertions pass.
beforeAll(async () => {
  if (!i18n.isInitialized) {
    await i18n.use(initReactI18next).init({
      resources: {
        ja: { translation: ja },
        en: { translation: en },
      },
      lng: 'en',
      fallbackLng: 'en',
      interpolation: { escapeValue: false },
    });
  } else {
    await i18n.changeLanguage('en');
  }
});

afterEach(cleanup);
