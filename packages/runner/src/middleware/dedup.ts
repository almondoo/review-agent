import { fingerprint as defaultFingerprint, type ReviewState } from '@review-agent/core';
import type { ReviewOutput, ReviewOutputComment } from '@review-agent/llm';

export type DedupResult = {
  readonly kept: ReadonlyArray<ReviewOutputComment & { readonly fingerprint: string }>;
  readonly droppedCount: number;
  /**
   * Number of comments suppressed because their fingerprint matched
   * a prior `factType: 'rejected_finding'` row in `review_history`
   * (spec §7.6, v1.2 epic #83 Phase 4 / #93). Stays at 0 when no
   * `rejectedFingerprints` are passed in. Surfaced separately from
   * `droppedCount` so the eval recorder can populate
   * `review_eval_event.dropped_by_feedback` and the operator can
   * measure the closed-loop effect.
   */
  readonly droppedByFeedback: number;
};

export type DedupOptions = {
  readonly previousState?: ReviewState | null;
  readonly fingerprintFn?: typeof defaultFingerprint;
  readonly suggestionTypeFor?: (c: ReviewOutputComment) => string;
  /**
   * Fingerprints the operator has already rejected via 👎 / dismiss
   * (Phase 3 / #92). Matches are dropped from the kept list and
   * counted in `droppedByFeedback`. Spec §7.6 caps this at 50
   * entries; the runner-level reader enforces the cap before
   * calling `dedupComments`.
   */
  readonly rejectedFingerprints?: ReadonlyArray<string>;
};

export function dedupComments(result: ReviewOutput, opts: DedupOptions = {}): DedupResult {
  const fingerprintFn = opts.fingerprintFn ?? defaultFingerprint;
  const suggestionTypeFor = opts.suggestionTypeFor ?? defaultSuggestionType;
  const seen = new Set(opts.previousState?.commentFingerprints ?? []);
  const rejected = new Set(opts.rejectedFingerprints ?? []);
  const fresh: Array<ReviewOutputComment & { fingerprint: string }> = [];
  let dropped = 0;
  let droppedByFeedback = 0;

  for (const c of result.comments) {
    const fp = fingerprintFn({
      path: c.path,
      line: c.line,
      ruleId: ruleIdFor(c),
      suggestionType: suggestionTypeFor(c),
    });
    if (rejected.has(fp)) {
      droppedByFeedback++;
      continue;
    }
    if (seen.has(fp)) {
      dropped++;
      continue;
    }
    seen.add(fp);
    fresh.push({ ...c, fingerprint: fp });
  }

  return { kept: fresh, droppedCount: dropped, droppedByFeedback };
}

function ruleIdFor(c: ReviewOutputComment): string {
  // Prefer the model-supplied ruleId when present — it's the stable
  // taxonomy id (e.g. `sql-injection`, `null-deref`) that distinguishes
  // two findings on the same line at the same severity. Fall back to
  // severity for back-compat with reviews emitted before ruleId existed:
  // collisions are still possible in the fallback path, but no worse
  // than the prior behavior.
  return c.ruleId ?? c.severity;
}

function defaultSuggestionType(c: ReviewOutputComment): string {
  return c.suggestion ? 'replacement' : 'comment';
}
