import type { Confidence, InlineComment, ReviewState, Severity, Side } from '@review-agent/core';
import type { LlmProvider, ReviewInput, ReviewOutput } from '@review-agent/llm';
import type { GitleaksFinding } from './gitleaks.js';

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
  /**
   * True when `diffText` is incremental (delta against `previousState.lastReviewedSha`).
   * The runner forwards this into the system-prompt composer so the LLM
   * knows it is reviewing only new commits, not the entire PR.
   */
  readonly incrementalContext?: boolean;
  /**
   * Reference commit for the incremental review (i.e. the `sinceSha`
   * passed to `vcs.getDiff`). Surfaced in the prompt for the LLM and
   * useful for observability. Ignored when `incrementalContext` is false.
   */
  readonly incrementalSinceSha?: string;
  /**
   * Operator-configured floor on model confidence
   * (`.review-agent.yml` `reviews.min_confidence`). Comments whose
   * confidence is strictly below this value are dropped before posting.
   * Defaults to `'low'` (post everything) when omitted; comments without
   * a confidence field are treated as `'high'`.
   */
  readonly minConfidence?: Confidence;
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
  /**
   * Number of tool calls (`read_file` / `glob` / `grep`) that the
   * LLM made during this review. Surfaced for cost-guard accounting
   * (§spec 6.2) and for the eval harness so regressions in tool use
   * are detectable.
   */
  readonly toolCalls: number;
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
  readonly scanContent?: (text: string) => ReadonlyArray<GitleaksFinding>;
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
