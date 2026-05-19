import { type FeedbackEvent, feedbackKindToFactType, isValidRegex } from '@review-agent/core';
import { applyRedactions, quickScanContent } from './gitleaks.js';

/**
 * Persists explicit human feedback (👍 / 👎 / dismissed) into the
 * `review_history` table for spec §7.6 "learned facts" (v1.2 epic
 * #83 Phase 3 / #92). The writer is provider-agnostic — the
 * platform-github adapter is responsible for translating raw
 * GitHub webhook bodies into a `FeedbackEvent` before calling
 * here.
 *
 * Responsibilities (spec §7.6):
 *
 * 1. **PII / secret redaction at insert time.** The free-text
 *    `factText` field is scanned with the same gitleaks built-in
 *    ruleset the review path uses; matches are replaced with
 *    `[REDACTED:<ruleId>]` so a reviewer who comments
 *    "this leaks AKIA…" doesn't get the secret stored verbatim.
 *    Operator-supplied `redactPatterns` extend the rule set.
 *
 * 2. **Per-job write rate-limit (default 10).** A single PR review
 *    cycle should not generate dozens of `review_history` rows;
 *    when callers exceed the cap the writer drops the excess and
 *    reports `dropped: true` so the operator can wire a metric or
 *    log.
 *
 * 3. **Fact-type discriminator.** `FeedbackKind` → `factType` via
 *    `feedbackKindToFactType` (single source of truth shared with
 *    Phase 4's reader).
 */

/**
 * Persistence side of the writer. Operators wire this via
 * `@review-agent/db`'s `createReviewHistoryWriter` so the runner
 * stays I/O-free outside this module.
 */
export type ReviewHistoryWriter = (input: {
  readonly installationId: bigint;
  readonly repo: string;
  readonly factType: 'accepted_pattern' | 'rejected_finding' | 'arch_decision';
  readonly factText: string;
}) => Promise<void>;

export type FeedbackWriterOptions = {
  readonly writer: ReviewHistoryWriter;
  /**
   * Operator-supplied regex patterns from `.review-agent.yml`
   * `privacy.redact_patterns`. Same convention as the runner's main
   * loop — extends gitleaks built-ins, never relaxes them. Empty
   * default is intentional so callers that don't thread privacy
   * config still get full built-in scanning.
   */
  readonly redactPatterns?: ReadonlyArray<string>;
  /**
   * Per-job soft cap on `review_history` inserts. spec §7.6 sets
   * the default at 10 / job to keep one PR's feedback bursts from
   * polluting the table. Pass the sentinel `'unlimited'` to bypass
   * the rate-limit entirely — intended for operator-driven backfill
   * paths (CLI `review-agent feedback backfill`, v1.2 follow-on #99)
   * where the operator has consciously opted out of the per-job cap.
   * The webhook receive path keeps the numeric default.
   */
  readonly maxWritesPerJob?: number | 'unlimited';
  /** Optional hook fired when the rate-limit drops a feedback event. */
  readonly onRateLimit?: (ev: FeedbackEvent) => void;
};

const DEFAULT_MAX_WRITES_PER_JOB = 10;

export type FeedbackWriter = {
  /**
   * Record one feedback event. Returns `dropped: true` when the
   * rate-limit suppressed the write; the caller (worker handler /
   * adapter) decides whether to log or surface the drop.
   */
  readonly record: (event: FeedbackEvent) => Promise<{ dropped: boolean }>;
};

/**
 * Build a stateful writer scoped to a single job. The `count`
 * counter lives on the closure so the rate-limit applies across
 * every feedback event emitted within the job (typically a single
 * webhook batch). Construct a new writer per job.
 */
export function createFeedbackWriter(opts: FeedbackWriterOptions): FeedbackWriter {
  const max: number | 'unlimited' = opts.maxWritesPerJob ?? DEFAULT_MAX_WRITES_PER_JOB;
  const patterns = (opts.redactPatterns ?? []).filter(isValidRegex);
  let count = 0;
  return {
    record: async (event) => {
      if (max !== 'unlimited' && count >= max) {
        opts.onRateLimit?.(event);
        return { dropped: true };
      }
      count += 1;
      const findings = [...quickScanContent(event.factText, patterns)];
      const redacted =
        findings.length === 0 ? event.factText : applyRedactions(event.factText, findings);
      const factType = feedbackKindToFactType(event.kind);
      // The runner-level `review_history` row stores the redacted
      // text plus a small structured prefix so Phase 4's reader can
      // route comments by fingerprint without re-deriving the link
      // from prose. spec §7.6 says rows are short opaque strings —
      // we keep the schema as `text` and encode the structure in
      // the value to avoid yet another migration.
      const factText = `[fp:${event.fingerprint}] ${redacted}`;
      await opts.writer({
        installationId: event.installationId,
        repo: event.repo,
        factType,
        factText,
      });
      return { dropped: false };
    },
  };
}
