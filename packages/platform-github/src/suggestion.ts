/**
 * Committable-suggestion helpers for the GitHub adapter (#152, #165).
 *
 * GitHub's ```suggestion block mechanism requires that the anchor line (the
 * `line` field in the review comment) exists on the RIGHT side of the diff
 * within a hunk context window. If the line is outside the diff hunks, the
 * GitHub API rejects the review with a 422. We therefore validate before
 * posting and suppress the suggestion block (keeping the plain comment body)
 * for any anchor that fails the check.
 *
 * ## Single-line model (#152, back-compat)
 * - `startLine` absent: the comment anchors at `line` only.
 * - Only RIGHT-side anchors are considered; LEFT-side suggestions are always
 *   suppressed (GitHub applies suggestions to the new file content only).
 *
 * ## Multi-line model (#165)
 * - `startLine` present: the suggestion covers `startLine`..`line` inclusive.
 * - Every line in the range must be a valid RIGHT-side hunk line in the same
 *   patch. If any line is outside the hunk (or the range spans two hunks),
 *   the suggestion is suppressed to a plain comment body.
 * - `startLine` must be strictly less than `line` (GitHub API constraint).
 *
 * ## Patch format
 * Unified diff hunk headers look like:
 *   @@ -a,b +c,d @@ [optional context]
 * where `c` is the first line on the new (RIGHT) side and `d` is the count.
 * Context lines (' ') and addition lines ('+') are valid anchor targets.
 * Removal lines ('-') appear on the LEFT side only and are not valid anchors.
 * When `d` is omitted (single-line hunk) it defaults to 1.
 */

const HUNK_HEADER_RE = /^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,(\d+))?\s+@@/;

/**
 * Parse a unified diff patch string and return the set of line numbers
 * on the RIGHT (new-file) side that are valid suggestion anchor targets.
 *
 * Valid targets are:
 * - Context lines (' '): unchanged lines included for context.
 * - Addition lines ('+'): newly-added lines.
 *
 * Deletion lines ('-') live only on the LEFT side and are excluded.
 *
 * @param patch - The raw unified diff patch string for a single file
 *   (e.g. `DiffFile.patch`). May be null/undefined when the file is
 *   binary or has no textual diff — in that case an empty set is returned.
 */
export function buildValidRightLines(patch: string | null | undefined): ReadonlySet<number> {
  if (!patch) return new Set<number>();

  const lines = patch.split('\n');
  const valid = new Set<number>();
  let currentLine = 0; // tracks current RIGHT-side line number

  for (const raw of lines) {
    const hunkMatch = HUNK_HEADER_RE.exec(raw);
    if (hunkMatch) {
      // Reset to the starting line of this hunk on the RIGHT side.
      // hunkMatch[1] is the start line (1-based).
      currentLine = parseInt(hunkMatch[1] ?? '1', 10);
      continue;
    }
    if (currentLine === 0) {
      // Haven't seen a hunk header yet — skip file-level header lines.
      continue;
    }

    const marker = raw[0];
    if (marker === ' ') {
      // Context line: exists on both sides; valid anchor on RIGHT.
      valid.add(currentLine);
      currentLine += 1;
    } else if (marker === '+') {
      // Addition line: exists only on RIGHT; valid anchor.
      valid.add(currentLine);
      currentLine += 1;
    } else if (marker === '-') {
      // Deletion line: exists only on LEFT side; does NOT advance the
      // RIGHT-side counter and is NOT a valid anchor.
    }
    // Lines starting with '\' (e.g. '\ No newline at end of file') or
    // other unexpected markers are ignored without advancing the counter.
  }

  return valid;
}

/**
 * Check whether every line in the range [startLine..endLine] (inclusive)
 * is a valid RIGHT-side anchor in `validRightLines`.
 *
 * Used for multi-line suggestion validation (#165). A range that spans a
 * hunk boundary or includes any line outside the diff context will have
 * at least one gap in the valid set, causing this function to return false
 * and triggering suppression to a plain comment body.
 *
 * @param startLine - First line of the range (inclusive, 1-based).
 * @param endLine   - Last line of the range (inclusive, 1-based).
 *   Must satisfy startLine < endLine (the caller's schema enforces this).
 * @param validRightLines - The set of valid RIGHT-side lines from
 *   {@link buildValidRightLines}.
 */
export function isRangeInHunk(
  startLine: number,
  endLine: number,
  validRightLines: ReadonlySet<number>,
): boolean {
  for (let line = startLine; line <= endLine; line++) {
    if (!validRightLines.has(line)) return false;
  }
  return true;
}

/**
 * Append a GitHub committable ```suggestion block to `body` when the
 * anchor is valid (RIGHT side, line within hunk), or return `body`
 * unchanged when the suggestion should be suppressed.
 *
 * Suppression conditions (suggestion is silently dropped; body posted as-is):
 *  - `suggestion` is absent/empty.
 *  - `side` is 'LEFT' (GitHub only supports new-file suggestions).
 *  - Single-line: `line` is not in `validRightLines`.
 *  - Multi-line (`startLine` present): `startSide` or `side` is 'LEFT',
 *    or any line in [startLine..line] is outside `validRightLines`,
 *    or `startLine >= line` (GitHub API constraint).
 *
 * The suggestion block is inserted BEFORE any trailing content (e.g. the
 * fingerprint marker appended by `appendFingerprintMarker`). Callers
 * should pass the plain body here and let `appendFingerprintMarker` run
 * after this function.
 */
export function buildSuggestionBody(
  body: string,
  suggestion: string | undefined,
  side: 'LEFT' | 'RIGHT',
  line: number,
  validRightLines: ReadonlySet<number>,
  startLine?: number,
  startSide?: 'LEFT' | 'RIGHT',
): string {
  if (!suggestion) return body;
  if (side === 'LEFT') return body;

  if (startLine !== undefined) {
    // Multi-line range validation (#165).
    // Suppress if startSide is explicitly LEFT.
    if (startSide === 'LEFT') return body;
    // Suppress if the GitHub constraint startLine < line is violated.
    // (The schema already enforces this, but be defensive here too.)
    if (startLine >= line) return body;
    // Suppress if any line in the range is outside the hunk.
    if (!isRangeInHunk(startLine, line, validRightLines)) return body;

    // All lines in range are valid — emit a multi-line suggestion block.
    return `${body}\n\n\`\`\`suggestion\n${suggestion}\n\`\`\``;
  }

  // Single-line path (back-compat with #152).
  if (!validRightLines.has(line)) return body;

  // Append the committable suggestion block after the comment body.
  // Two blank lines separate the body from the block so GitHub renders
  // them as distinct paragraphs rather than merging them inline.
  return `${body}\n\n\`\`\`suggestion\n${suggestion}\n\`\`\``;
}
