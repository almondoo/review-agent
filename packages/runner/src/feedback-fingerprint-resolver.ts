/**
 * `/feedback` fingerprint resolver — v1.2 #95.
 *
 * Translates a `/feedback ...` comment plus the parent (bot) comment's
 * body plus the known set of `review_state.commentFingerprints` into a
 * concrete fingerprint that points at one of the bot's inline comments.
 *
 * Two resolution paths exist (spec §7.6 follow-on / #95 AC):
 *
 *   (a) **Marker extraction.** When the parent comment carries a
 *       `<!-- fingerprint:<fp> -->` HTML marker (depends on #96), the
 *       resolver pulls the fingerprint straight out of the body. This
 *       is the recommended path because it requires zero user input.
 *
 *   (b) **`<fp_prefix>` argument.** When the marker is absent (or
 *       #96's embedding is still pending), the user disambiguates by
 *       typing `/feedback reject <fp_prefix>` with at least 8 hex
 *       chars. The resolver prefix-matches against
 *       `commentFingerprints`. Exactly one match → success. Zero
 *       matches → `no_match`. Two-or-more matches → `ambiguous_prefix`
 *       (handled by the receiver as `unresolved` for metrics).
 *
 *   (c) Neither marker nor prefix given → `no_marker_and_no_prefix`.
 *
 * NOTE: until #96 (fingerprint marker embedding in posted PR comments)
 * ships, the marker extractor is wired but always returns `null` from
 * the actual receiver path because the bot never writes the marker.
 * The regex extraction function is implemented and tested so the day
 * #96 lands the resolver picks up the (a) path with zero changes
 * here.
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
 * Regex for the HTML-comment marker `#96` will start writing into bot
 * comments. Lowercase hex, 8+ chars, surrounded by `<!-- fingerprint:`
 * / `-->`. Matches inside a body even with surrounding text so the
 * marker can travel alongside the rendered comment.
 *
 * The marker is the **link** between a reaction-equivalent reply (CodeCommit
 * `/feedback`) and the fingerprint stored in `review_state.commentFingerprints`.
 */
const FINGERPRINT_MARKER_REGEX = /<!--\s*fingerprint:([0-9a-f]{8,})\s*-->/i;

/**
 * Pure helper: extract the marker fingerprint from a body string.
 * Returns `null` when no marker is present. Exposed for unit tests
 * so the day #96 lands its `composeStateComment` change we can flip
 * a single fixture and watch resolution succeed.
 *
 * TODO: #96 (fingerprint embedding) landed 後にここで marker 抽出を実装
 * — currently the receiver flow does not depend on the result of
 * this function because no bot comment yet carries the marker. The
 * tests pin the contract so the wiring is forward-compatible.
 */
export function extractFingerprintMarker(body: string): string | null {
  const m = body.match(FINGERPRINT_MARKER_REGEX);
  if (!m) return null;
  const fp = m[1];
  return fp ? fp.toLowerCase() : null;
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
