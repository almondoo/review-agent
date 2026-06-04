/**
 * Committable-suggestion helpers for the GitHub adapter (#152).
 *
 * GitHub's ```suggestion block mechanism requires that the anchor line (the
 * `line` field in the review comment) exists on the RIGHT side of the diff
 * within a hunk context window. If the line is outside the diff hunks, the
 * GitHub API rejects the review with a 422. We therefore validate before
 * posting and suppress the suggestion block (keeping the plain comment body)
 * for any anchor that fails the check.
 *
 * ## Scope
 * - Single-anchor-line model only (#152 scope). Multi-line range (`start_line`)
 *   is NOT supported in this version. Follow-up issue to add start_line support.
 * - Only RIGHT-side anchors are considered; LEFT-side suggestions are always
 *   suppressed (GitHub applies suggestions to the new file content only).
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
 * Append a GitHub committable ```suggestion block to `body` when the
 * anchor is valid (RIGHT side, line within hunk), or return `body`
 * unchanged when the suggestion should be suppressed.
 *
 * Suppression conditions (suggestion is silently dropped; body posted as-is):
 *  - `suggestion` is absent/empty.
 *  - `side` is 'LEFT' (GitHub only supports new-file suggestions).
 *  - `line` is not in `validRightLines` (anchor outside diff context).
 *
 * The suggestion block is inserted BEFORE any trailing content (e.g. the
 * fingerprint marker appended by `appendFingerprintMarker`). Callers
 * should pass the plain body here and let `appendFingerprintMarker` run
 * after this function.
 *
 * Multi-line range (start_line) is out of scope for #152. The suggestion
 * text itself may span multiple lines — GitHub replaces the single anchor
 * line with the entire multi-line suggestion text when the user clicks
 * "Apply suggestion". start_line support is tracked as a follow-up issue.
 */
export function buildSuggestionBody(
  body: string,
  suggestion: string | undefined,
  side: 'LEFT' | 'RIGHT',
  line: number,
  validRightLines: ReadonlySet<number>,
): string {
  if (!suggestion) return body;
  if (side === 'LEFT') return body;
  if (!validRightLines.has(line)) return body;

  // Append the committable suggestion block after the comment body.
  // Two blank lines separate the body from the block so GitHub renders
  // them as distinct paragraphs rather than merging them inline.
  return `${body}\n\n\`\`\`suggestion\n${suggestion}\n\`\`\``;
}
