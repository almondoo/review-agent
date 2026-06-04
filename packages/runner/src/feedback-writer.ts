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
 *
 * 4. **Suppression-rule creation (#155).** When `suppressionOpts` is
 *    supplied and a `rejected_finding` write succeeds, the writer
 *    checks whether the rejection count for that fingerprint has
 *    reached the `suppressAfter` threshold. If it has, and no active
 *    suppression rule exists yet, a `suppression_rule` row is created.
 *    Errors from the threshold checker / suppression writer are
 *    swallowed (fail-open) — a transient DB blip must not prevent the
 *    primary `rejected_finding` row from being stored.
 */

/**
 * Persistence side of the writer. Operators wire this via
 * `@review-agent/db`'s `createReviewHistoryWriter` so the runner
 * stays I/O-free outside this module.
 */
export type ReviewHistoryWriter = (input: {
  readonly installationId: bigint;
  readonly repo: string;
  readonly factType: 'accepted_pattern' | 'rejected_finding' | 'arch_decision' | 'suppression_rule';
  readonly factText: string;
}) => Promise<void>;

/**
 * Options for the #155 suppression-rule creation path. All three
 * fields are required together — supplying only some is a programmer
 * error. The feedback writer does NOT perform partial checks.
 */
export type SuppressionOpts = {
  /**
   * Number of 👎 signals on the same fingerprint before a suppression
   * rule is created. Sourced from `config.feedback.suppress_after`
   * (default 3). Must be ≥ 1.
   */
  readonly suppressAfter: number;
  /**
   * Counts non-expired `rejected_finding` rows whose `factText` begins
   * with `[fp:<fingerprint>]`. Wired to `countRejectionsByFingerprint`
   * from `@review-agent/db`.
   */
  readonly rejectionCounter: (q: {
    readonly installationId: bigint;
    readonly repo: string;
    readonly fingerprint: string;
  }) => Promise<number>;
  /**
   * Checks for an existing active `suppression_rule` for the fingerprint.
   * Wired to `loadActiveSuppressionRules` from `@review-agent/db`.
   * Returns the suppression rows (only the factText is needed for the
   * dedup guard).
   */
  readonly suppressionLoader: (q: {
    readonly installationId: bigint;
    readonly repo: string;
  }) => Promise<ReadonlyArray<{ readonly factText: string }>>;
  /**
   * Persists the new `suppression_rule` row. Wired to
   * `createSuppressionRule` from `@review-agent/db`.
   */
  readonly suppressionWriter: (input: {
    readonly installationId: bigint;
    readonly repo: string;
    readonly fingerprint: string;
    readonly reason: string;
  }) => Promise<void>;
  /**
   * Optional observability hook — fired (repo: string) when a new
   * suppression rule is created. Wire to
   * `bridgeSuppressionRulesCreatedToMetrics()` in the server worker.
   */
  readonly onSuppressionRuleCreated?: (repo: string) => void;
};

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
  /**
   * #155 false-positive suppression. When present, each successful
   * `rejected_finding` write triggers a threshold check: if the count
   * of non-expired `rejected_finding` rows for that fingerprint has
   * reached `suppressAfter`, and no active suppression rule exists yet,
   * a `suppression_rule` row is created. Errors are swallowed
   * (fail-open) — a transient DB blip must not prevent the primary
   * `rejected_finding` row from being stored.
   */
  readonly suppressionOpts?: SuppressionOpts;
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

      // #155: suppression threshold check — only for rejected signals.
      if (factType === 'rejected_finding' && opts.suppressionOpts !== undefined) {
        await maybeCreateSuppressionRule(event, opts.suppressionOpts);
      }

      return { dropped: false };
    },
  };
}

/**
 * Internal: check whether the suppression threshold has been crossed for
 * the given fingerprint and, if so, create a `suppression_rule` row (unless
 * one already exists). Errors are swallowed so the primary record() call
 * always succeeds regardless of a transient DB failure here.
 */
async function maybeCreateSuppressionRule(
  event: FeedbackEvent,
  so: SuppressionOpts,
): Promise<void> {
  try {
    const count = await so.rejectionCounter({
      installationId: event.installationId,
      repo: event.repo,
      fingerprint: event.fingerprint,
    });
    if (count < so.suppressAfter) return;

    // Check for an existing active suppression rule to avoid duplicates.
    const existing = await so.suppressionLoader({
      installationId: event.installationId,
      repo: event.repo,
    });
    const alreadySuppressed = existing.some((r) =>
      r.factText.startsWith(`[fp:${event.fingerprint}]`),
    );
    if (alreadySuppressed) return;

    await so.suppressionWriter({
      installationId: event.installationId,
      repo: event.repo,
      fingerprint: event.fingerprint,
      reason: `Auto-suppressed after ${count} rejection(s) (threshold: ${so.suppressAfter})`,
    });
    so.onSuppressionRuleCreated?.(event.repo);
  } catch {
    // Fail-open: a suppression DB failure must not prevent the feedback
    // writer from recording the primary `rejected_finding` row.
  }
}
