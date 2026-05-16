import { describe, expect, it } from 'vitest';
import { globToRegExp, isValidGlob } from './glob.js';

const NUL = String.fromCharCode(0);

describe('globToRegExp', () => {
  it('compiles a literal path to a regex that matches only that path', () => {
    const re = globToRegExp('src/index.ts');
    expect(re.test('src/index.ts')).toBe(true);
    expect(re.test('src/index.tsx')).toBe(false);
    expect(re.test('test/src/index.ts')).toBe(false);
  });

  it('`*` matches within a single path segment but NOT across segments', () => {
    const re = globToRegExp('src/*.ts');
    expect(re.test('src/index.ts')).toBe(true);
    expect(re.test('src/utils/index.ts')).toBe(false);
  });

  it('`**` matches across path segments', () => {
    const re = globToRegExp('src/**/*.ts');
    expect(re.test('src/index.ts')).toBe(true);
    expect(re.test('src/utils/index.ts')).toBe(true);
    expect(re.test('src/a/b/c/d.ts')).toBe(true);
    expect(re.test('test/src/index.ts')).toBe(false);
  });

  it('escapes regex metacharacters so literal `.`/`+`/`(` etc. are not interpreted', () => {
    const re = globToRegExp('docs/notes (draft).md');
    expect(re.test('docs/notes (draft).md')).toBe(true);
    // The escaped `.` does not match other chars.
    expect(re.test('docs/notes (draft)Xmd')).toBe(false);
  });

  it('rejects an empty pattern', () => {
    expect(() => globToRegExp('')).toThrow(/non-empty/);
  });

  it('rejects a pattern containing a NUL byte', () => {
    expect(() => globToRegExp(`src/${NUL}/x.ts`)).toThrow(/NUL/);
  });
});

describe('isValidGlob', () => {
  it('returns true for valid patterns the config schema accepts', () => {
    expect(isValidGlob('src/*.ts')).toBe(true);
    expect(isValidGlob('**/*.test.ts')).toBe(true);
    expect(isValidGlob('docs/notes (draft).md')).toBe(true);
  });

  it('returns false for empty / NUL-byte inputs', () => {
    expect(isValidGlob('')).toBe(false);
    expect(isValidGlob(`src/${NUL}/x.ts`)).toBe(false);
  });
});
