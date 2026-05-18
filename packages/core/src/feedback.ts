import type { ReviewHistoryFactType } from './db/schema/review-history.js';

/**
 * Sources of explicit human feedback on a posted review comment
 * (spec §7.6, v1.2 epic #83 Phase 3). The platform-github adapter
 * + server webhook handler translate raw GitHub events into this
 * shape so the runner-side writer is provider-neutral.
 *
 * - `'thumbs_up'`   — 👍 reaction on the inline comment. Maps to
 *                     `factType: 'accepted_pattern'`.
 * - `'thumbs_down'` — 👎 reaction. Maps to `factType: 'rejected_finding'`.
 * - `'dismissed'`   — reviewer dismissed the agent's review
 *                     (`pull_request_review.dismissed`) or marked
 *                     the inline comment as outdated. Maps to
 *                     `factType: 'rejected_finding'`.
 */
export const FEEDBACK_KINDS = ['thumbs_up', 'thumbs_down', 'dismissed'] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];

/**
 * Translated feedback signal. Runner-side writer consumes this; the
 * platform adapter is responsible for producing it from raw GitHub
 * webhook bodies (Phase 3 #92 adapter additions).
 */
export type FeedbackEvent = {
  readonly installationId: bigint;
  readonly repo: string;
  /** PR number the original review comment was attached to. */
  readonly prNumber: number;
  /**
   * Fingerprint of the originally-posted comment (per spec §7.7.1).
   * The runner writer matches this against `commentFingerprints` in
   * `review_state` to confirm the feedback targets a comment we
   * actually posted.
   */
  readonly fingerprint: string;
  readonly kind: FeedbackKind;
  /**
   * Short verbatim text describing the feedback (e.g. "👎 reaction
   * by alice", "dismissed: 'this is a false positive'"). The
   * writer redacts secrets before insertion; do not pre-redact at
   * the adapter so the writer can apply consistent rules.
   */
  readonly factText: string;
  /**
   * UTC timestamp of the user action — used by the rate-limiter to
   * scope "10 writes per job" to a single review job window.
   */
  readonly occurredAt: Date;
};

/**
 * Maps a `FeedbackKind` into the corresponding `review_history` row
 * factType discriminator. Single source of truth for the mapping so
 * Phase 4's reader can interpret the rows symmetrically.
 */
export function feedbackKindToFactType(kind: FeedbackKind): ReviewHistoryFactType {
  if (kind === 'thumbs_up') return 'accepted_pattern';
  return 'rejected_finding';
}
