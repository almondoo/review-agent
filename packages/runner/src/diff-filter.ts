import { globToRegExp } from '@review-agent/core';

/**
 * Per-file segment carved out of a `ReviewJob.diffText`. The payload
 * format the action / cli entry points build is:
 *
 *   `--- <path>\n<patch>` joined by `\n` across all files
 *
 * where `<patch>` is the upstream VCS adapter's per-file hunk text
 * (e.g. GitHub's `pulls.listFiles[].patch`, which starts with the
 * first `@@ -... +... @@` hunk header and has no `diff --git` or
 * `+++ b/<path>` decoration). `body` here is everything *after* the
 * `--- <path>` line until the next file boundary (or end of input),
 * without the trailing newline that joined it to the next segment.
 *
 * Empty `body` is normal for binary / rename-only entries: the VCS
 * adapter passes `null` patch through as `''` in action / cli.
 */
export type ParsedDiffFile = {
  readonly path: string;
  readonly body: string;
};

/**
 * Result of splitting a `ReviewJob.diffText` into per-file segments.
 *
 * `preamble` holds any content that appears BEFORE the first
 * `--- <path>` header. For diffText produced by `action/run.ts` and
 * `cli/commands/review.ts` this is always empty (their `join('\n')`
 * starts with `--- `). It is kept as a separate field so the
 * round-trip `parse -> reassemble` is lossless on arbitrary input —
 * test fixtures that use `'diff --git a/x b/x'` as a stand-in for a
 * full diff land entirely in `preamble`, and the cap pipeline in T3
 * still receives an unmodified payload when `files.length === 0`.
 */
export type ParsedDiff = {
  readonly preamble: string;
  readonly files: ReadonlyArray<ParsedDiffFile>;
};

// File-boundary recognizer for the action / cli `diffText` format.
// We split on any line that starts with `--- ` (literal three
// hyphens + space), reading the rest of the line as the path.
//
// This is intentionally narrower than a real `git diff` parser:
// - In production input, every file is prefixed by a single
//   `--- <path>` header (action / cli prepend `--- ${f.path}` and the
//   VCS adapter's per-file patch contains no `--- a/<path>` /
//   `+++ b/<path>` decoration). One marker = one file.
// - In real `git diff` output, both `--- a/<path>` and `+++ b/<path>`
//   decorations would appear, and `--- a/<path>` would be the
//   recognized boundary — the `a/` prefix would survive as part of
//   the parsed path. We don't strip `a/` here because production
//   input never has it; doing so would silently corrupt paths that
//   legitimately start with `a/` (e.g. `a/b/foo.ts` in a project
//   whose root has an `a` directory).
//
// Theoretical false-positive: a hunk deletion line of the literal
// shape `--- <path>` would be misread as a new file boundary. We
// accept that risk because (a) the source line `--- foo` is
// vanishingly rare in real code, (b) detecting it would require a
// stateful hunk-aware parser, and (c) downstream caps fail open: a
// bogus split simply over-counts files, which makes the run skip
// MORE eagerly, never less.
const FILE_HEADER_LINE = /^--- (.+)$/;

/**
 * Split a raw `ReviewJob.diffText` into per-file segments + any
 * leading preamble. Pure / deterministic; consumes no I/O.
 *
 * Contract:
 * - `parseDiffByFile('')` returns `{ preamble: '', files: [] }`.
 * - Any text appearing before the first `--- <path>` line is
 *   returned verbatim in `preamble`.
 * - A `--- ` line with NO path (the literal five bytes `'--- '`)
 *   is treated as non-matching content by virtue of the recognizer
 *   regex (`(.+)` requires at least one character). It is folded
 *   back into the previous file's `body` (or `preamble` if no file
 *   is open), which keeps the parser from inventing a zero-path
 *   file segment that downstream glob matching could not handle.
 * - The trailing newline that joined two adjacent file segments is
 *   stripped from the previous segment's body; `reassembleDiff`
 *   restores it on output so a `parse -> reassemble` round-trip is
 *   lossless for the action / cli format.
 */
export function parseDiffByFile(diff: string): ParsedDiff {
  if (diff.length === 0) return { preamble: '', files: [] };

  const lines = diff.split('\n');
  const preambleLines: string[] = [];
  const files: Array<{ path: string; bodyLines: string[] }> = [];
  let currentFile: { path: string; bodyLines: string[] } | null = null;

  for (const line of lines) {
    // Strip a trailing CR before regex matching: `\r\n`-terminated
    // input survives the `split('\n')` with a CR still attached to
    // each line, and the regex `.` class in JS does NOT match `\r`
    // — without this normalization the header recognizer silently
    // misses every file on Windows-style payloads.
    const normalized = line.endsWith('\r') ? line.slice(0, -1) : line;
    const match = normalized.match(FILE_HEADER_LINE);
    if (match?.[1]) {
      currentFile = { path: match[1], bodyLines: [] };
      files.push(currentFile);
      continue;
    }
    if (currentFile) currentFile.bodyLines.push(line);
    else preambleLines.push(line);
  }

  return {
    preamble: preambleLines.join('\n'),
    files: files.map((f) => ({ path: f.path, body: f.bodyLines.join('\n') })),
  };
}

/**
 * Drop every file whose path matches at least one entry in
 * `filters` (spec §10 L1435 — `reviews.path_filters` is an EXCLUDE
 * list, not an include allow-list). Globs are compiled with
 * `globToRegExp` from `@review-agent/core`, so the same caveat that
 * applies to `privacy.deny_paths` applies here:
 *
 * - Anchored full-path match. `vendor/**` excludes `vendor/foo.ts`
 *   but not `pkg/vendor/foo.ts`. Use `**\/vendor/**` to match a
 *   directory at any depth.
 * - Forward-slash separator. Windows-style `\` paths are not
 *   normalized; callers MUST already use POSIX separators (the VCS
 *   adapters do).
 * - Case-sensitive (the underlying regex has no `i` flag).
 * - No `?` / `[...]` / `{a,b}` syntax. Unsupported metacharacters
 *   are matched literally by `globToRegExp` and therefore exclude
 *   nothing.
 *
 * Empty `filters` (the default operator value, an empty `path_filters`
 * list) is the documented "filter nothing" sentinel — every file is
 * kept untouched. `preamble` is always preserved so a `parse ->
 * filter -> reassemble` round-trip leaves non-file content alone.
 *
 * The function compiles each filter once and reuses the compiled
 * regex across every file, so `O(filters * files)` is the total cost
 * (no per-file recompilation).
 */
export function applyPathFilters(parsed: ParsedDiff, filters: ReadonlyArray<string>): ParsedDiff {
  if (filters.length === 0) return parsed;
  const matchers = filters.map((g) => globToRegExp(g));
  const kept = parsed.files.filter((f) => !matchers.some((re) => re.test(f.path)));
  if (kept.length === parsed.files.length) return parsed;
  return { preamble: parsed.preamble, files: kept };
}

/**
 * Inverse of `parseDiffByFile`: render a `ParsedDiff` back to the
 * `--- <path>\n<body>` joined-by-`\n` shape that the agent loop
 * expects in `ReviewJob.diffText`. Round-trip-safe for input
 * produced by action / cli (`parse -> reassemble === input`).
 *
 * Layout details:
 * - `preamble` is emitted verbatim before any file segments.
 * - Each file segment is emitted as `--- <path>\n<body>`; when
 *   `body` is empty (binary / rename-only) the trailing newline is
 *   still inserted so the next file's header lands on its own line.
 * - Adjacent segments are joined with the same `\n` that the action /
 *   cli `Array.prototype.join('\n')` originally inserted.
 */
export function reassembleDiff(parsed: ParsedDiff): string {
  const parts: string[] = [];
  if (parsed.preamble.length > 0) parts.push(parsed.preamble);
  for (const f of parsed.files) {
    parts.push(f.body.length > 0 ? `--- ${f.path}\n${f.body}` : `--- ${f.path}`);
  }
  return parts.join('\n');
}

/**
 * Count "diff lines" for the `max_diff_lines` cap (spec §10 L1450).
 *
 * Operators reason about `max_diff_lines` in the same units that
 * `git diff --stat` reports — the additions + deletions across all
 * kept files — so we count hunk lines that start with `+` or `-`,
 * skipping the `+++ ` / `--- ` file-header decoration that some
 * upstream patch payloads include. Context lines (` ` prefix) and
 * `\ No newline at end of file` markers (`\` prefix) do NOT count.
 *
 * Counting at this granularity (rather than `body.split('\n').length`)
 * means an operator who sets `max_diff_lines: 3000` is bounding the
 * meaningful change volume, not punishing diffs that happen to have
 * many context lines (e.g. moving a 5-line block inside a 1000-line
 * file). The cap is applied per `ParsedDiff` so it sees only the
 * files that survived `applyPathFilters`.
 */
export function countDiffLines(parsed: ParsedDiff): number {
  let total = 0;
  for (const f of parsed.files) {
    if (f.body.length === 0) continue;
    const lines = f.body.split('\n');
    for (const line of lines) {
      if (line.length === 0) continue;
      const first = line.charCodeAt(0);
      // '+' === 43, '-' === 45
      if (first !== 43 && first !== 45) continue;
      // Skip the `+++ ` / `--- ` file-decoration lines that real
      // `git diff` output sometimes embeds inside a file body (the
      // action / cli format does not produce them, but a future
      // refactor that fed raw `git diff` here would).
      if (line.startsWith('+++ ') || line.startsWith('--- ')) continue;
      total += 1;
    }
  }
  return total;
}
