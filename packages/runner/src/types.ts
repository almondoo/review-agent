import type { InlineComment, ReviewState, Severity, Side } from '@review-agent/core';
import type { LlmProvider, ReviewInput, ReviewOutput } from '@review-agent/llm';

export type ReviewJob = {
  readonly jobId: string;
  readonly workspaceDir: string;
  readonly diffText: string;
  readonly prMetadata: {
    readonly title: string;
    readonly body: string;
    readonly author: string;
  };
  readonly previousState: ReviewState | null;
  readonly profile: string;
  readonly pathInstructions: ReadonlyArray<{ readonly pattern: string; readonly text: string }>;
  readonly skills: ReadonlyArray<string>;
  readonly language: string;
  readonly costCapUsd: number;
};

export type FinalizedComment = InlineComment & {
  readonly title?: string;
};

export type RunnerResult = {
  readonly comments: ReadonlyArray<InlineComment>;
  readonly summary: string;
  readonly costUsd: number;
  readonly tokensUsed: { readonly input: number; readonly output: number };
  readonly model: string;
  readonly provider: string;
  readonly droppedDuplicates: number;
};

export type RunReviewDeps = {
  readonly fileReader?: (path: string) => Promise<string>;
  readonly fingerprintComment?: (c: {
    readonly path: string;
    readonly line: number;
    readonly side: Side;
    readonly severity: Severity;
    readonly body: string;
  }) => string;
};

export type Middleware = (
  ctx: MiddlewareCtx,
  next: () => Promise<ReviewOutput>,
) => Promise<ReviewOutput>;

export type MiddlewareCtx = {
  readonly job: ReviewJob;
  readonly input: ReviewInput;
  readonly provider: LlmProvider;
};
