import { describe, expect, it } from 'vitest';
import { assertSafeRelativePath } from './path-guard.js';

describe('assertSafeRelativePath', () => {
  it('accepts simple relative paths', () => {
    expect(() => assertSafeRelativePath('src/index.ts')).not.toThrow();
    expect(() => assertSafeRelativePath('package.json')).not.toThrow();
  });

  it('rejects empty path', () => {
    expect(() => assertSafeRelativePath('')).toThrow(/empty/);
  });

  it('rejects absolute paths', () => {
    expect(() => assertSafeRelativePath('/etc/passwd')).toThrow(/absolute/);
  });

  it('rejects home-expanded paths', () => {
    expect(() => assertSafeRelativePath('~/.ssh/id_rsa')).toThrow(/home/);
  });

  it('rejects parent traversal', () => {
    expect(() => assertSafeRelativePath('../etc/passwd')).toThrow(/traversal/);
    expect(() => assertSafeRelativePath('foo/../etc/passwd')).toThrow(/traversal/);
    expect(() => assertSafeRelativePath('foo/..')).toThrow(/traversal/);
  });

  it('rejects paths with NUL byte', () => {
    expect(() => assertSafeRelativePath('foo\0.ts')).toThrow(/NUL/);
  });

  it('accepts paths containing dots that are not traversal', () => {
    expect(() => assertSafeRelativePath('src/.config.ts')).not.toThrow();
    expect(() => assertSafeRelativePath('src/file.test.ts')).not.toThrow();
  });
});
