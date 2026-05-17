import { describe, expect, it } from 'vitest';
import { isValidRegex } from './regex.js';

const NUL = String.fromCharCode(0);

describe('isValidRegex', () => {
  it('accepts a simple literal pattern', () => {
    expect(isValidRegex('AKIA[0-9A-Z]{16}')).toBe(true);
  });

  it('accepts an anchored pattern with capture groups', () => {
    expect(isValidRegex('^(sk|pk)_(test|live)_[A-Za-z0-9]{24,}$')).toBe(true);
  });

  it('rejects an empty pattern', () => {
    expect(isValidRegex('')).toBe(false);
  });

  it('rejects a pattern containing a NUL byte', () => {
    expect(isValidRegex(`AKIA${NUL}[0-9A-Z]{16}`)).toBe(false);
  });

  it('rejects an unbalanced bracket', () => {
    // `[a-z` is invalid — `new RegExp` throws SyntaxError.
    expect(isValidRegex('[a-z')).toBe(false);
  });

  it('rejects an invalid quantifier', () => {
    // Lone `*` with nothing to repeat is a SyntaxError in `new RegExp`.
    expect(isValidRegex('*invalid')).toBe(false);
  });
});
