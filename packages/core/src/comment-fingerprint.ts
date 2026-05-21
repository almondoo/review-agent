/**
 * Embedding format for the inline-comment fingerprint that travels
 * with each Bot-posted PR / MR comment so command-based feedback
 * (`/feedback accept`, `/feedback reject` — #95) can resolve which
 * finding the operator is reacting to without DB lookups.
 *
 * Format: `<!-- fingerprint:<16-hex> -->`
 *
 * - `<16-hex>` is the full 16-char `fingerprint()` output from
 *   `./fingerprint.ts` (the same value stored in
 *   `ReviewState.commentFingerprints`).
 * - GitHub and CodeCommit both render this as a hidden HTML comment,
 *   so end-user UX is unaffected. The marker is stripped by readers
 *   that need plain text.
 * - The regex tolerates extra whitespace inside the marker so casual
 *   manual edits do not break resolution, and accepts prefixes ≥ 8
 *   chars so #95's `/feedback <fp_prefix>` argument path can share
 *   the same constant.
 *
 * spec §7.6.1 (review_history reader / writer) + #96.
 */

const FINGERPRINT_MARKER_REGEX = /<!--\s*fingerprint:([0-9a-f]{8,16})\s*-->/i;

/**
 * Append the hidden `<!-- fingerprint:<fp> -->` marker to a comment
 * body so a downstream reader can recover the fingerprint via
 * `extractFingerprintFromComment`. Adapters (`@review-agent/platform-*`)
 * call this once per inline comment in their `postReview` path.
 *
 * Idempotent: if the body already ends with the same marker the
 * original body is returned unchanged. This keeps re-posts from
 * accumulating duplicate markers if a caller forgets to strip first.
 */
export function appendFingerprintMarker(body: string, fingerprint: string): string {
  const expected = `<!-- fingerprint:${fingerprint} -->`;
  if (body.trimEnd().endsWith(expected)) return body;
  const sep = body.endsWith('\n') ? '' : '\n\n';
  return `${body}${sep}${expected}`;
}

/**
 * Reader-side helper. Returns the first fingerprint embedded in the
 * comment body (lowercased), or `null` when no marker is present.
 *
 * Reader is intentionally tolerant:
 * - Case-insensitive (`Fingerprint:` and `FINGERPRINT:` accepted).
 * - Extra whitespace inside the marker permitted.
 * - 8–16 hex chars accepted so #95's `/feedback <fp_prefix>` can
 *   funnel through the same regex even with partial fingerprints
 *   pasted by the operator.
 */
export function extractFingerprintFromComment(body: string): string | null {
  const m = body.match(FINGERPRINT_MARKER_REGEX);
  if (!m || !m[1]) return null;
  return m[1].toLowerCase();
}
