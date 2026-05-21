import { extractFingerprintFromComment } from '@review-agent/core';

/**
 * `/feedback` fingerprint resolver — v1.2 #95 + #96.
 *
 * Translates a `/feedback ...` comment plus the parent (bot) comment's
 * body plus the known set of `review_state.commentFingerprints` into a
 * concrete fingerprint that points at one of the bot's inline comments.
 *
 * Two resolution paths exist (spec §7.6 follow-on):
 *
 *   (a) **Marker extraction.** The bot embeds `<!-- fingerprint:<fp> -->`
 *       in every inline comment (writer side: #96, via
 *       `appendFingerprintMarker` from `@review-agent/core`). The
 *       resolver pulls the fingerprint straight out of the parent
 *       body. This is the recommended path because it requires zero
 *       user input.
 *
 *   (b) **`<fp_prefix>` argument.** When the marker is absent (e.g.
 *       comments posted before #96 shipped), the user disambiguates
 *       by typing `/feedback reject <fp_prefix>` with at least 8 hex
 *       chars. The resolver prefix-matches against
 *       `commentFingerprints`. Exactly one match → success. Zero
 *       matches → `no_match`. Two-or-more matches → `ambiguous_prefix`
 *       (handled by the receiver as `unresolved` for metrics).
 *
 *   (c) Neither marker nor prefix given → `no_marker_and_no_prefix`.
 */

export type FingerprintResolutionInput = {
  /** Parent (bot) comment body that the `/feedback` reply targets. */
  readonly commentBody: string;
  /** Optional `<fp_prefix>` argument from `/feedback accept <prefix>`. */
  readonly fpPrefix?: string;
  /**
   * Snapshot of `review_state.commentFingerprints` for the PR. The
   * resolver only matches against this set — random user-supplied
   * hex never resolves to a foreign fingerprint.
   */
  readonly knownFingerprints: ReadonlyArray<string>;
};

export type FingerprintResolution =
  | { readonly ok: true; readonly fingerprint: string; readonly source: 'marker' | 'prefix' }
  | {
      readonly ok: false;
      readonly reason: 'no_match' | 'ambiguous_prefix' | 'no_marker_and_no_prefix';
    };

/**
 * Pure helper: extract the marker fingerprint from a body string. Thin
 * alias for `@review-agent/core`'s `extractFingerprintFromComment` so
 * existing callers of this resolver module keep working without
 * importing core directly.
 */
export function extractFingerprintMarker(body: string): string | null {
  return extractFingerprintFromComment(body);
}

/**
 * Resolve a `/feedback` reply to a `commentFingerprints` entry.
 *
 * Resolution precedence:
 *
 *   1. Marker on the parent body wins outright. If the marker matches
 *      a known fingerprint, return it. If it matches *no* known
 *      fingerprint, fall through to `<fp_prefix>` and treat the
 *      marker as informational only (defensive against bot rewrites).
 *   2. `<fp_prefix>` prefix-match against `knownFingerprints`. 1 hit
 *      succeeds; 2+ hits → `ambiguous_prefix`; 0 hits → `no_match`.
 *   3. Otherwise → `no_marker_and_no_prefix`.
 */
export function resolveFingerprint(input: FingerprintResolutionInput): FingerprintResolution {
  const marker = extractFingerprintMarker(input.commentBody);
  if (marker !== null && input.knownFingerprints.includes(marker)) {
    return { ok: true, fingerprint: marker, source: 'marker' };
  }

  if (input.fpPrefix !== undefined) {
    const needle = input.fpPrefix.toLowerCase();
    const matches = input.knownFingerprints.filter((fp) => fp.startsWith(needle));
    if (matches.length === 1) {
      const hit = matches[0];
      if (hit !== undefined) {
        return { ok: true, fingerprint: hit, source: 'prefix' };
      }
    }
    if (matches.length > 1) {
      return { ok: false, reason: 'ambiguous_prefix' };
    }
    return { ok: false, reason: 'no_match' };
  }

  return { ok: false, reason: 'no_marker_and_no_prefix' };
}
