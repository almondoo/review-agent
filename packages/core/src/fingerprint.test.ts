import { describe, expect, it } from 'vitest';
import { fingerprint } from './fingerprint.js';

describe('fingerprint', () => {
  const base = {
    path: 'src/index.ts',
    line: 42,
    ruleId: 'security/sql-injection',
    suggestionType: 'replacement',
  };

  it('returns 16 hex characters', () => {
    expect(fingerprint(base)).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is deterministic for identical input', () => {
    expect(fingerprint(base)).toBe(fingerprint({ ...base }));
  });

  it('matches the spec format `path:line:ruleId:suggestionType` (sha256 prefix)', () => {
    // sha256('a.ts:1:r:t') prefix 16 hex chars — locks the canonical input
    // format and the truncation length. If anyone reorders the fields, changes
    // the separator, or swaps the hash, this fails.
    expect(fingerprint({ path: 'a.ts', line: 1, ruleId: 'r', suggestionType: 't' })).toBe(
      '6c94ff9c7e054313',
    );
  });

  it('changes when path differs', () => {
    expect(fingerprint({ ...base, path: 'src/other.ts' })).not.toBe(fingerprint(base));
  });

  it('changes when line differs', () => {
    expect(fingerprint({ ...base, line: 43 })).not.toBe(fingerprint(base));
  });

  it('changes when ruleId differs', () => {
    expect(fingerprint({ ...base, ruleId: 'style/naming' })).not.toBe(fingerprint(base));
  });

  it('changes when suggestionType differs', () => {
    expect(fingerprint({ ...base, suggestionType: 'comment-only' })).not.toBe(fingerprint(base));
  });

  it('is stable across many calls (no global mutation)', () => {
    const first = fingerprint(base);
    for (let i = 0; i < 50; i++) {
      expect(fingerprint(base)).toBe(first);
    }
  });

  it('is case-sensitive (spec does not normalize)', () => {
    expect(fingerprint({ ...base, ruleId: 'SECURITY/SQL-INJECTION' })).not.toBe(fingerprint(base));
  });
});
