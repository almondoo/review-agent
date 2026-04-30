const TRAVERSAL_REGEX = /(^|[/\\])\.\.([/\\]|$)/;

export function assertSafeRelativePath(path: string): void {
  if (!path) throw new Error('Refusing empty path');
  if (path.startsWith('/')) throw new Error(`Refusing absolute path: '${path}'`);
  if (path.startsWith('~')) throw new Error(`Refusing home-expanded path: '${path}'`);
  if (TRAVERSAL_REGEX.test(path)) throw new Error(`Refusing traversal path: '${path}'`);
  if (path.includes('\0')) throw new Error('Refusing path with NUL byte');
}
