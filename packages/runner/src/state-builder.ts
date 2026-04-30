import type { InlineComment, ReviewState } from '@review-agent/core';

export type BuildStateInput = {
  readonly previousState: ReviewState | null;
  readonly comments: ReadonlyArray<InlineComment>;
  readonly headSha: string;
  readonly baseSha: string;
  readonly modelUsed: string;
  readonly tokensUsed: number;
  readonly costUsd: number;
};

export function buildReviewState(input: BuildStateInput): ReviewState {
  const previousFingerprints = input.previousState?.commentFingerprints ?? [];
  const newFingerprints = input.comments.map((c) => c.fingerprint);
  const merged = Array.from(new Set([...previousFingerprints, ...newFingerprints]));
  return {
    schemaVersion: 1,
    lastReviewedSha: input.headSha,
    baseSha: input.baseSha,
    reviewedAt: new Date().toISOString(),
    modelUsed: input.modelUsed,
    totalTokens: (input.previousState?.totalTokens ?? 0) + input.tokensUsed,
    totalCostUsd: (input.previousState?.totalCostUsd ?? 0) + input.costUsd,
    commentFingerprints: merged,
  };
}
