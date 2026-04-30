import { describe, expect, it } from 'vitest';
import { fingerprint } from './fingerprint.js';

describe('fingerprint', () => {
  const base = {
    path: 'src/index.ts',
    line: 42,
    category: 'security',
    title: 'SQL injection risk',
  };

  it('returns 16 hex characters', () => {
    const fp = fingerprint(base);
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is deterministic for identical input', () => {
    expect(fingerprint(base)).toBe(fingerprint({ ...base }));
  });

  it('is case-insensitive on title', () => {
    const upper = fingerprint({ ...base, title: 'SQL Injection Risk' });
    const lower = fingerprint({ ...base, title: 'sql injection risk' });
    expect(upper).toBe(lower);
  });

  it('ignores leading/trailing whitespace in title', () => {
    const padded = fingerprint({ ...base, title: '  SQL injection risk  ' });
    expect(padded).toBe(fingerprint(base));
  });

  it('changes when path differs', () => {
    expect(fingerprint({ ...base, path: 'src/other.ts' })).not.toBe(fingerprint(base));
  });

  it('changes when line differs', () => {
    expect(fingerprint({ ...base, line: 43 })).not.toBe(fingerprint(base));
  });

  it('changes when category differs', () => {
    expect(fingerprint({ ...base, category: 'style' })).not.toBe(fingerprint(base));
  });

  it('changes when title differs in meaningful content', () => {
    expect(fingerprint({ ...base, title: 'XSS risk' })).not.toBe(fingerprint(base));
  });

  it('is stable across many calls (no global mutation)', () => {
    const first = fingerprint(base);
    for (let i = 0; i < 50; i++) {
      expect(fingerprint(base)).toBe(first);
    }
  });
});
