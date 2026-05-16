/**
 * Convert a small subset of glob syntax (the one the runner's tool
 * dispatcher and the .review-agent.yml `path_instructions[*].path`
 * field both speak) into an anchored regular expression.
 *
 * Supported:
 * - `*`  — matches any sequence of characters EXCEPT path separators.
 * - `**` — matches any sequence including path separators.
 * - Literal characters (regex metacharacters are escaped).
 *
 * NOT supported (deliberately — kept small to match `runner/src/tools.ts`):
 * - Character classes (`[...]`)
 * - `?` single-char wildcards
 * - Brace expansion (`{a,b}`)
 *
 * Throws when the pattern contains a NUL byte or is empty — both
 * indicate a malformed config entry that should fail at load time
 * rather than silently never match.
 */
// Built at module load via String.fromCharCode(0) rather than a
// backslash-zero source literal — that escape gets expanded into a
// real 0x00 byte by some write tools on save, contaminating the
// source file with an embedded NUL.
const NUL_BYTE = String.fromCharCode(0);

export function globToRegExp(pattern: string): RegExp {
  if (!pattern) {
    throw new Error('glob pattern must be non-empty');
  }
  if (pattern.includes(NUL_BYTE)) {
    throw new Error('glob pattern must not contain a NUL byte');
  }
  // Escape regex metacharacters in the user-supplied pattern first.
  let s = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  // Translate glob wildcards. Order matters; we use markers so the
  // intermediate substitutions don't get caught by the next pass.
  //
  // `**/` is the "zero or more segments, then a slash" wildcard:
  //   `src/**/foo.ts` matches BOTH `src/foo.ts` and `src/a/b/foo.ts`.
  //   So we map it to `(?:.*/)?` — the trailing slash is optional.
  // Remaining `**` (no following slash, typically at end of pattern,
  // e.g. `src/**`) matches any character sequence including slashes.
  // Single `*` matches within a path segment only.
  s = s.replace(/\*\*\//g, '§GLOBDOUBLEDIR§');
  s = s.replace(/\*\*/g, '§GLOBDOUBLE§');
  s = s.replace(/\*/g, '[^/]*');
  s = s.replace(/§GLOBDOUBLEDIR§/g, '(?:.*/)?');
  s = s.replace(/§GLOBDOUBLE§/g, '.*');
  // `new RegExp` throws on syntactically invalid regex shapes that
  // survive our escape pass — we let that throw propagate so the
  // config loader can attach a clear message.
  return new RegExp(`^${s}$`);
}

/**
 * Soft-validate a glob: returns whether `globToRegExp(pattern)` would
 * succeed without actually keeping the compiled regex. Used by the
 * config schema's `.refine` to reject typos at load time.
 */
export function isValidGlob(pattern: string): boolean {
  try {
    globToRegExp(pattern);
    return true;
  } catch {
    return false;
  }
}
