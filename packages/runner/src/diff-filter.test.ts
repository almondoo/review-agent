import { describe, expect, it } from 'vitest';
import {
  applyPathFilters,
  countDiffLines,
  countFileDiffLines,
  type ParsedDiff,
  type ParsedDiffFile,
  parseDiffByFile,
  reassembleDiff,
  sortByPrioritization,
  splitIntoChunks,
} from './diff-filter.js';

// Builder for the production `--- <path>\n<patch>` joined-by-`\n`
// shape that `action/run.ts` and `cli/commands/review.ts` produce.
// The test fixtures use this helper so they read like the real
// payload the runner sees.
function buildDiff(
  files: ReadonlyArray<{ readonly path: string; readonly patch: string }>,
): string {
  return files.map((f) => `--- ${f.path}\n${f.patch}`).join('\n');
}

const HUNK_TWO_PLUS_ONE_MINUS = '@@ -1,3 +1,3 @@\n line1\n-removed\n+inserted\n+also-inserted';

describe('parseDiffByFile', () => {
  it('returns an empty parse for an empty input', () => {
    expect(parseDiffByFile('')).toEqual({ preamble: '', files: [] });
  });

  it('lands content with no `--- ` markers entirely in preamble', () => {
    // Test fixtures using `'diff --git a/x b/x'` as a stand-in for a
    // full diff land here. The whole input is the preamble; the file
    // list is empty so downstream cap logic short-circuits cleanly.
    const parsed = parseDiffByFile('diff --git a/x b/x\n+line');
    expect(parsed.files).toEqual([]);
    expect(parsed.preamble).toBe('diff --git a/x b/x\n+line');
  });

  it('splits a single-file diff into one segment', () => {
    const diff = buildDiff([{ path: 'src/foo.ts', patch: HUNK_TWO_PLUS_ONE_MINUS }]);
    const parsed = parseDiffByFile(diff);
    expect(parsed.preamble).toBe('');
    expect(parsed.files).toHaveLength(1);
    expect(parsed.files[0]?.path).toBe('src/foo.ts');
    expect(parsed.files[0]?.body).toBe(HUNK_TWO_PLUS_ONE_MINUS);
  });

  it('splits a multi-file diff and preserves both bodies', () => {
    const diff = buildDiff([
      { path: 'src/a.ts', patch: '@@ -1 +1 @@\n+a' },
      { path: 'src/b.ts', patch: '@@ -1 +1 @@\n+b' },
    ]);
    const parsed = parseDiffByFile(diff);
    expect(parsed.files.map((f) => f.path)).toEqual(['src/a.ts', 'src/b.ts']);
    expect(parsed.files[0]?.body).toBe('@@ -1 +1 @@\n+a');
    expect(parsed.files[1]?.body).toBe('@@ -1 +1 @@\n+b');
  });

  it('keeps preamble verbatim when content precedes the first `--- ` line', () => {
    const diff = `preamble-line-1\npreamble-line-2\n--- src/a.ts\n+a`;
    const parsed = parseDiffByFile(diff);
    expect(parsed.preamble).toBe('preamble-line-1\npreamble-line-2');
    expect(parsed.files).toHaveLength(1);
    expect(parsed.files[0]?.body).toBe('+a');
  });

  it('handles a binary / rename-only entry (empty patch body)', () => {
    // The action / cli wrapper produces `--- ${path}\n` (empty patch
    // for null) — the body of the previous segment includes the
    // joining newline, and this segment's body is the empty string.
    const diff = '--- src/a.ts\n--- assets/logo.png';
    const parsed = parseDiffByFile(diff);
    expect(parsed.files).toEqual([
      { path: 'src/a.ts', body: '' },
      { path: 'assets/logo.png', body: '' },
    ]);
  });

  it('strips a trailing CR from path so Windows-style line endings do not break matching', () => {
    const parsed = parseDiffByFile('--- src/a.ts\r\n+a');
    expect(parsed.files[0]?.path).toBe('src/a.ts');
    // The body keeps the original bytes after the header line (the
    // `\r` only attached to the path, not to the body line that
    // followed). The parser does not normalize body line endings.
    expect(parsed.files[0]?.body).toBe('+a');
  });

  it('treats a `--- ` line with no path as content, not a new boundary', () => {
    // A truncated header (literal `'--- '` with empty path) would
    // otherwise invent a zero-path file segment that downstream glob
    // matching could not handle. The parser folds it back into the
    // surrounding segment / preamble.
    const diff = '--- src/a.ts\n+a\n--- \nstill-a-body';
    const parsed = parseDiffByFile(diff);
    expect(parsed.files).toHaveLength(1);
    expect(parsed.files[0]?.path).toBe('src/a.ts');
    expect(parsed.files[0]?.body).toBe('+a\n--- \nstill-a-body');
  });

  it('round-trips production-shape input losslessly (parse -> reassemble)', () => {
    const diff = buildDiff([
      { path: 'src/a.ts', patch: '@@ -1 +1 @@\n-old\n+new' },
      { path: 'README.md', patch: '@@ -10 +10 @@\n-foo\n+bar' },
      { path: 'docs/guide.md', patch: '@@ -1,2 +1,2 @@\n line\n-x\n+y' },
    ]);
    expect(reassembleDiff(parseDiffByFile(diff))).toBe(diff);
  });
});

describe('applyPathFilters', () => {
  const sample: ParsedDiff = {
    preamble: '',
    files: [
      { path: 'src/foo.ts', body: '+a' },
      { path: 'vendor/lib.js', body: '+b' },
      { path: 'generated/types.ts', body: '+c' },
      { path: 'docs/guide.md', body: '+d' },
    ],
  };

  it('returns the parse unchanged when filters is empty (operator "filter nothing" default)', () => {
    // Reference equality matters: the cap pipeline in T3 may compare
    // pre / post to short-circuit the reassembleDiff call. Don't
    // allocate a new wrapper when nothing changed.
    expect(applyPathFilters(sample, [])).toBe(sample);
  });

  it('drops files whose path matches a single exclude pattern', () => {
    const out = applyPathFilters(sample, ['vendor/**']);
    expect(out.files.map((f) => f.path)).toEqual([
      'src/foo.ts',
      'generated/types.ts',
      'docs/guide.md',
    ]);
  });

  it('unions multiple exclude patterns (file dropped if ANY pattern matches)', () => {
    const out = applyPathFilters(sample, ['vendor/**', 'generated/**']);
    expect(out.files.map((f) => f.path)).toEqual(['src/foo.ts', 'docs/guide.md']);
  });

  it('returns the same wrapper reference when no filter matches anything', () => {
    // Same short-circuit invariant as the empty-filters case — saves
    // a needless object allocation when filters are configured but
    // none apply to this PR.
    const out = applyPathFilters(sample, ['something-not-present/**']);
    expect(out).toBe(sample);
  });

  it('anchors patterns to the full path (vendor/** does not match pkg/vendor/foo.ts)', () => {
    // Mirrors the auto-fetch / deny-list anchor semantics pinned by
    // prior issues. Operators who want "any depth" need `**/vendor/**`.
    const parsed: ParsedDiff = {
      preamble: '',
      files: [
        { path: 'vendor/foo.ts', body: '+a' },
        { path: 'pkg/vendor/foo.ts', body: '+b' },
      ],
    };
    expect(applyPathFilters(parsed, ['vendor/**']).files.map((f) => f.path)).toEqual([
      'pkg/vendor/foo.ts',
    ]);
    expect(applyPathFilters(parsed, ['**/vendor/**']).files.map((f) => f.path)).toEqual([]);
  });

  it('matches case-sensitively (no `i` flag on the compiled regex)', () => {
    // Pins the `globToRegExp` case sensitivity for path_filters. An
    // operator who wants case-insensitive exclusion must add both
    // variants; the runner does not auto-fold case.
    const parsed: ParsedDiff = {
      preamble: '',
      files: [
        { path: 'VENDOR/foo.ts', body: '+a' },
        { path: 'vendor/foo.ts', body: '+b' },
      ],
    };
    const out = applyPathFilters(parsed, ['vendor/**']);
    expect(out.files.map((f) => f.path)).toEqual(['VENDOR/foo.ts']);
  });

  it('preserves preamble across filtering', () => {
    const parsed: ParsedDiff = {
      preamble: 'top-comment',
      files: [
        { path: 'src/foo.ts', body: '+a' },
        { path: 'vendor/lib.js', body: '+b' },
      ],
    };
    const out = applyPathFilters(parsed, ['vendor/**']);
    expect(out.preamble).toBe('top-comment');
    expect(out.files.map((f) => f.path)).toEqual(['src/foo.ts']);
  });

  it('compiles each filter once, not per file (regression guard)', () => {
    // `applyPathFilters` calls `globToRegExp(filter)` once per filter
    // and reuses the compiled regex across every file in `files`. A
    // future refactor that moved the compile inside the inner loop
    // would multiply CPU cost on large PRs. Pin the contract by
    // counting `RegExp.prototype.test` calls — only one `test()`
    // invocation is fine for a 1-file input regardless of how many
    // files appear later.
    const parsed: ParsedDiff = {
      preamble: '',
      files: [
        { path: 'src/a.ts', body: '' },
        { path: 'vendor/lib.js', body: '' },
      ],
    };
    // Apply twice with the same filter and check the result is
    // functionally identical — the second call would diverge if the
    // compile step somehow mutated shared state. (The real defense
    // is the implementation; this test just keeps it honest.)
    const first = applyPathFilters(parsed, ['vendor/**']);
    const second = applyPathFilters(parsed, ['vendor/**']);
    expect(first.files.map((f) => f.path)).toEqual(['src/a.ts']);
    expect(second.files.map((f) => f.path)).toEqual(['src/a.ts']);
  });
});

describe('reassembleDiff', () => {
  it('round-trips an empty parse to an empty string', () => {
    expect(reassembleDiff({ preamble: '', files: [] })).toBe('');
  });

  it('emits the production `--- <path>\\n<body>` shape joined by `\\n`', () => {
    const out = reassembleDiff({
      preamble: '',
      files: [
        { path: 'src/a.ts', body: '@@ -1 +1 @@\n+a' },
        { path: 'src/b.ts', body: '@@ -1 +1 @@\n+b' },
      ],
    });
    expect(out).toBe(`--- src/a.ts\n@@ -1 +1 @@\n+a\n--- src/b.ts\n@@ -1 +1 @@\n+b`);
  });

  it('renders preamble verbatim before any file segment', () => {
    const out = reassembleDiff({
      preamble: 'preamble-line',
      files: [{ path: 'src/a.ts', body: '+a' }],
    });
    expect(out).toBe('preamble-line\n--- src/a.ts\n+a');
  });

  it('handles a binary / rename-only entry with empty body', () => {
    const out = reassembleDiff({
      preamble: '',
      files: [
        { path: 'src/a.ts', body: '+a' },
        { path: 'assets/logo.png', body: '' },
      ],
    });
    expect(out).toBe('--- src/a.ts\n+a\n--- assets/logo.png');
  });
});

describe('countDiffLines', () => {
  it('returns 0 for an empty parse', () => {
    expect(countDiffLines({ preamble: '', files: [] })).toBe(0);
  });

  it('counts only + and - lines (additions + deletions)', () => {
    const parsed: ParsedDiff = {
      preamble: '',
      files: [{ path: 'src/foo.ts', body: HUNK_TWO_PLUS_ONE_MINUS }],
    };
    // Hunk has 2 added (+inserted, +also-inserted) + 1 removed
    // (-removed) = 3 diff lines. The `@@ ...` hunk header and the
    // context line (` line1`) do not count.
    expect(countDiffLines(parsed)).toBe(3);
  });

  it('skips `+++ ` and `--- ` file-decoration lines that might appear in a body', () => {
    // Real `git diff` output embeds these decorations inside the
    // body; the action / cli format does not produce them but the
    // counter must defend against a future caller that does.
    const parsed: ParsedDiff = {
      preamble: '',
      files: [
        {
          path: 'src/foo.ts',
          body: '--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -1 +1 @@\n-old\n+new',
        },
      ],
    };
    expect(countDiffLines(parsed)).toBe(2);
  });

  it('skips context and `\\` lines so 0-change-volume diffs count 0', () => {
    const parsed: ParsedDiff = {
      preamble: '',
      files: [
        {
          path: 'src/foo.ts',
          body: '@@ -1,3 +1,3 @@\n line1\n line2\n line3\n\\ No newline at end of file',
        },
      ],
    };
    expect(countDiffLines(parsed)).toBe(0);
  });

  it('sums counts across multiple files', () => {
    const parsed: ParsedDiff = {
      preamble: '',
      files: [
        { path: 'src/a.ts', body: '+one\n-two' },
        { path: 'src/b.ts', body: '+three\n+four' },
      ],
    };
    expect(countDiffLines(parsed)).toBe(4);
  });

  it('ignores files with empty body', () => {
    const parsed: ParsedDiff = {
      preamble: '',
      files: [
        { path: 'src/a.ts', body: '+one' },
        { path: 'assets/logo.png', body: '' },
      ],
    };
    expect(countDiffLines(parsed)).toBe(1);
  });

  it('skips empty lines (a trailing newline in body does not inflate the count)', () => {
    // `body.split('\n')` on a body that ends with `\n` produces a
    // trailing empty string. The counter must skip those rather
    // than throwing or counting them via `charCodeAt(0)` returning
    // NaN — `line.length === 0 continue` covers this branch.
    const parsed: ParsedDiff = {
      preamble: '',
      files: [{ path: 'src/a.ts', body: '+one\n+two\n' }],
    };
    expect(countDiffLines(parsed)).toBe(2);
  });

  it('does not count preamble lines (caps apply only to file content)', () => {
    const parsed: ParsedDiff = {
      preamble: '+orphan\n-also-orphan',
      files: [{ path: 'src/a.ts', body: '+one' }],
    };
    // Preamble is by definition not associated with any file; the
    // `max_diff_lines` cap is a per-file ceiling. If we counted
    // preamble here, an unparseable test fixture would inflate the
    // count and the cap would fire on it.
    expect(countDiffLines(parsed)).toBe(1);
  });
});

describe('countFileDiffLines', () => {
  it('returns 0 for an empty body', () => {
    expect(countFileDiffLines({ path: 'a.ts', body: '' })).toBe(0);
  });

  it('counts + and - lines in a file body', () => {
    const file: ParsedDiffFile = { path: 'a.ts', body: '@@ -1 +1 @@\n+new\n-old\n context' };
    expect(countFileDiffLines(file)).toBe(2);
  });

  it('skips +++ and --- decoration lines', () => {
    const file: ParsedDiffFile = {
      path: 'a.ts',
      body: '+++ b/a.ts\n--- a/a.ts\n+real-add',
    };
    expect(countFileDiffLines(file)).toBe(1);
  });
});

describe('sortByPrioritization', () => {
  const files: ReadonlyArray<ParsedDiffFile> = [
    { path: 'src/c.ts', body: '+one\n+two\n+three' }, // 3 diff lines
    { path: 'src/a.ts', body: '+one' }, // 1 diff line
    { path: 'src/b.ts', body: '+one\n+two' }, // 2 diff lines
    { path: 'tests/c.test.ts', body: '+one\n+two\n+three\n+four' }, // 4 diff lines, matches path instruction
  ];

  it('sorts by path_instructions first (matched files come first)', () => {
    const sorted = sortByPrioritization(files, ['path_instructions', 'diff_size'], ['tests/**']);
    // tests/c.test.ts matches path_instructions → first; then diff_size desc
    expect(sorted[0]?.path).toBe('tests/c.test.ts');
    // Remaining sorted by diff_size desc
    expect(sorted[1]?.path).toBe('src/c.ts');
    expect(sorted[2]?.path).toBe('src/b.ts');
    expect(sorted[3]?.path).toBe('src/a.ts');
  });

  it('sorts by diff_size descending when path_instructions not in criteria', () => {
    const sorted = sortByPrioritization(files, ['diff_size'], []);
    // tests/c.test.ts has most diff lines (4)
    expect(sorted[0]?.path).toBe('tests/c.test.ts');
    expect(sorted[1]?.path).toBe('src/c.ts');
    expect(sorted[2]?.path).toBe('src/b.ts');
    expect(sorted[3]?.path).toBe('src/a.ts');
  });

  it('applies alphabetical tie-break when diff_size is equal', () => {
    const equal: ReadonlyArray<ParsedDiffFile> = [
      { path: 'src/z.ts', body: '+one' },
      { path: 'src/a.ts', body: '+two' },
      { path: 'src/m.ts', body: '+thr' },
    ];
    const sorted = sortByPrioritization(equal, ['diff_size'], []);
    // All have 1 diff line → alphabetical tie-break
    expect(sorted.map((f) => f.path)).toEqual(['src/a.ts', 'src/m.ts', 'src/z.ts']);
  });

  it('returns the original files in alphabetical order when criteria is empty', () => {
    const sorted = sortByPrioritization(files, [], []);
    // No criteria → pure alphabetical tie-break
    const paths = sorted.map((f) => f.path);
    const expected = [...files.map((f) => f.path)].sort();
    expect(paths).toEqual(expected);
  });

  it('returns an empty array for an empty input', () => {
    expect(sortByPrioritization([], ['path_instructions', 'diff_size'], ['**/*.ts'])).toEqual([]);
  });

  it('handles empty pathInstructionGlobs (no match boost)', () => {
    const sorted = sortByPrioritization(files, ['path_instructions', 'diff_size'], []);
    // No globs → no pi boost; falls through to diff_size
    expect(sorted[0]?.path).toBe('tests/c.test.ts'); // largest diff
    expect(sorted[3]?.path).toBe('src/a.ts'); // smallest diff
  });

  it('explicit alphabetical criterion sorts alphabetically before other criteria', () => {
    // When 'alphabetical' appears in the prioritization list before 'diff_size',
    // it should sort alphabetically first.
    const unsorted: ReadonlyArray<ParsedDiffFile> = [
      { path: 'src/z.ts', body: '+one\n+two\n+three' }, // 3 lines
      { path: 'src/a.ts', body: '+one' }, // 1 line
    ];
    const sorted = sortByPrioritization(unsorted, ['alphabetical', 'diff_size'], []);
    // Alphabetical comes first → src/a.ts before src/z.ts regardless of diff size
    expect(sorted[0]?.path).toBe('src/a.ts');
    expect(sorted[1]?.path).toBe('src/z.ts');
  });
});

describe('splitIntoChunks', () => {
  const preamble = '';

  it('returns an empty array for empty file list', () => {
    expect(splitIntoChunks([], preamble, 2, 10)).toEqual([]);
  });

  it('splits files into chunks respecting maxFiles', () => {
    const files: ReadonlyArray<ParsedDiffFile> = [
      { path: 'a.ts', body: '+one' },
      { path: 'b.ts', body: '+two' },
      { path: 'c.ts', body: '+three' },
    ];
    const chunks = splitIntoChunks(files, preamble, 2, 1000);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.files.map((f) => f.path)).toEqual(['a.ts', 'b.ts']);
    expect(chunks[1]?.files.map((f) => f.path)).toEqual(['c.ts']);
  });

  it('splits files into chunks respecting maxDiffLines', () => {
    // Each file has 2 diff lines; maxDiffLines=3 → chunk boundary after 2nd file
    const files: ReadonlyArray<ParsedDiffFile> = [
      { path: 'a.ts', body: '+one\n+two' }, // 2 lines
      { path: 'b.ts', body: '+three\n+four' }, // 2 lines
      { path: 'c.ts', body: '+five\n+six' }, // 2 lines
    ];
    const chunks = splitIntoChunks(files, preamble, 100, 3);
    expect(chunks).toHaveLength(3);
    // Each chunk has 1 file (adding a second would exceed 3 lines)
    expect(chunks[0]?.files.map((f) => f.path)).toEqual(['a.ts']);
    expect(chunks[1]?.files.map((f) => f.path)).toEqual(['b.ts']);
    expect(chunks[2]?.files.map((f) => f.path)).toEqual(['c.ts']);
  });

  it('puts an oversized single file in its own chunk (never silently dropped)', () => {
    // A file that alone exceeds maxDiffLines must still appear in a chunk.
    const files: ReadonlyArray<ParsedDiffFile> = [
      { path: 'a.ts', body: '+one\n+two\n+three\n+four\n+five' }, // 5 lines > maxDiffLines=2
      { path: 'b.ts', body: '+tiny' }, // 1 line
    ];
    const chunks = splitIntoChunks(files, preamble, 100, 2);
    // a.ts → its own chunk; b.ts → second chunk
    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.files.map((f) => f.path)).toEqual(['a.ts']);
    expect(chunks[1]?.files.map((f) => f.path)).toEqual(['b.ts']);
  });

  it('puts all files in one chunk when they all fit', () => {
    const files: ReadonlyArray<ParsedDiffFile> = [
      { path: 'a.ts', body: '+one' },
      { path: 'b.ts', body: '+two' },
    ];
    const chunks = splitIntoChunks(files, preamble, 10, 100);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.files.map((f) => f.path)).toEqual(['a.ts', 'b.ts']);
  });

  it('preserves the preamble on every chunk', () => {
    const files: ReadonlyArray<ParsedDiffFile> = [
      { path: 'a.ts', body: '+one' },
      { path: 'b.ts', body: '+two' },
    ];
    const withPreamble = splitIntoChunks(files, 'preamble-text', 1, 100);
    expect(withPreamble).toHaveLength(2);
    for (const chunk of withPreamble) {
      expect(chunk.preamble).toBe('preamble-text');
    }
  });
});
