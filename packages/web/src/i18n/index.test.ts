import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LANG_STORAGE_KEY, resolveInitialLanguage } from './index.js';

describe('resolveInitialLanguage', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('returns stored value "ja" from localStorage when present', () => {
    localStorage.setItem(LANG_STORAGE_KEY, 'ja');
    expect(resolveInitialLanguage()).toBe('ja');
  });

  it('returns stored value "en" from localStorage when present', () => {
    localStorage.setItem(LANG_STORAGE_KEY, 'en');
    expect(resolveInitialLanguage()).toBe('en');
  });

  it('detects "ja" from navigator.language starting with "ja"', () => {
    vi.stubGlobal('navigator', { language: 'ja-JP' });
    expect(resolveInitialLanguage()).toBe('ja');
  });

  it('detects "ja" from navigator.language exactly "ja"', () => {
    vi.stubGlobal('navigator', { language: 'ja' });
    expect(resolveInitialLanguage()).toBe('ja');
  });

  it('detects "en" from navigator.language starting with "en"', () => {
    vi.stubGlobal('navigator', { language: 'en-US' });
    expect(resolveInitialLanguage()).toBe('en');
  });

  it('detects "en" from navigator.language that is not "ja"', () => {
    vi.stubGlobal('navigator', { language: 'fr-FR' });
    expect(resolveInitialLanguage()).toBe('en');
  });

  it('returns "en" when navigator.language is empty (non-ja resolves to en)', () => {
    vi.stubGlobal('navigator', { language: '' });
    expect(resolveInitialLanguage()).toBe('en');
  });

  it('persists resolved language to localStorage when no stored value exists', () => {
    vi.stubGlobal('navigator', { language: 'en-US' });
    resolveInitialLanguage();
    expect(localStorage.getItem(LANG_STORAGE_KEY)).toBe('en');
  });

  it('stored value takes priority over navigator.language', () => {
    localStorage.setItem(LANG_STORAGE_KEY, 'en');
    vi.stubGlobal('navigator', { language: 'ja-JP' });
    expect(resolveInitialLanguage()).toBe('en');
  });

  it('ignores invalid stored value and falls back to navigator detection', () => {
    localStorage.setItem(LANG_STORAGE_KEY, 'invalid-value');
    vi.stubGlobal('navigator', { language: 'ja' });
    expect(resolveInitialLanguage()).toBe('ja');
  });
});
