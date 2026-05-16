import { fingerprint as defaultFingerprint, type ReviewState } from '@review-agent/core';
import type { ReviewOutput, ReviewOutputComment } from '@review-agent/llm';

export type DedupResult = {
  readonly kept: ReadonlyArray<ReviewOutputComment & { readonly fingerprint: string }>;
  readonly droppedCount: number;
};

export type DedupOptions = {
  readonly previousState?: ReviewState | null;
  readonly fingerprintFn?: typeof defaultFingerprint;
  readonly suggestionTypeFor?: (c: ReviewOutputComment) => string;
};

export function dedupComments(result: ReviewOutput, opts: DedupOptions = {}): DedupResult {
  const fingerprintFn = opts.fingerprintFn ?? defaultFingerprint;
  const suggestionTypeFor = opts.suggestionTypeFor ?? defaultSuggestionType;
  const seen = new Set(opts.previousState?.commentFingerprints ?? []);
  const fresh: Array<ReviewOutputComment & { fingerprint: string }> = [];
  let dropped = 0;

  for (const c of result.comments) {
    const fp = fingerprintFn({
      path: c.path,
      line: c.line,
      ruleId: ruleIdFor(c),
      suggestionType: suggestionTypeFor(c),
    });
    if (seen.has(fp)) {
      dropped++;
      continue;
    }
    seen.add(fp);
    fresh.push({ ...c, fingerprint: fp });
  }

  return { kept: fresh, droppedCount: dropped };
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
