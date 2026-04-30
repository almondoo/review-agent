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
  return c.severity;
}

function defaultSuggestionType(c: ReviewOutputComment): string {
  return c.suggestion ? 'replacement' : 'comment';
}
