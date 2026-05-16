import type {
  Confidence,
  InlineComment,
  RequestChangesThreshold,
  ReviewEvent,
  ReviewState,
  Severity,
  Side,
} from '@review-agent/core';
import type { LlmProvider, ReviewInput, ReviewOutput } from '@review-agent/llm';
import type { GitleaksFinding } from './gitleaks.js';

export type ReviewJob = {
  readonly jobId: string;
  readonly workspaceDir: string;
  readonly diffText: string;
  /**
   * Paths of files touched by the diff (relative to repo root).
   * When supplied, the runner drives `path_instructions[*].autoFetch`
   * against this list to prefetch related files (tests / types /
   * siblings) into the LLM prompt. Optional for back-compat: callers
   * that don't supply it get no auto-fetch.
   */
  readonly changedPaths?: ReadonlyArray<string>;
  readonly prMetadata: {
    readonly title: string;
    readonly body: string;
    readonly author: string;
    /**
     * Base branch the PR targets (e.g. `main`, `release/1.x`). Used by
     * the LLM as a hint for review strictness — a release branch
     * typically warrants tighter scrutiny than a feature-flag branch.
     * Optional for back-compat with callers that haven't been updated.
     */
    readonly baseRef?: string;
    /**
     * Operator-assigned PR labels (e.g. `hotfix`, `performance`,
     * `breaking-change`). Surfaced to the LLM as soft hints; never
     * authoritative — the system prompt explicitly instructs the
     * model not to let labels suppress a critical finding.
     */
    readonly labels?: ReadonlyArray<string>;
    /**
     * Recent commit messages on the PR head, oldest → newest. Capped
     * upstream at the adapter level (e.g. last 20, each ≤ 5 KB). Empty
     * for platforms that don't expose commit listings (CodeCommit).
     */
    readonly commitMessages?: ReadonlyArray<{ readonly sha: string; readonly message: string }>;
  };
  readonly previousState: ReviewState | null;
  readonly profile: string;
  readonly pathInstructions: ReadonlyArray<{
    readonly pattern: string;
    readonly text: string;
    /**
     * When set, the runner auto-prefetches related files for every
     * changed file matching `pattern` and threads their content into
     * the LLM prompt as a `<related_files>` block. Per-fetch and
     * total-payload caps are enforced by the runner; see
     * `runner/src/auto-fetch.ts`.
     */
    readonly autoFetch?: {
      readonly tests?: boolean;
      readonly types?: boolean;
      readonly siblings?: boolean;
    };
  }>;
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
  /**
   * Operator-configured threshold at which the GitHub adapter posts
   * `REQUEST_CHANGES` instead of `COMMENT` (`.review-agent.yml`
   * `reviews.request_changes_on`). Defaults to `'critical'` when
   * omitted — matches the v0.1-conservative "block on critical only"
   * semantic. `'never'` disables the mapping (always `COMMENT`).
   */
  readonly requestChangesOn?: RequestChangesThreshold;
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
  /**
   * GitHub review event computed from the kept comment list +
   * `job.requestChangesOn`. The caller passes this through into
   * `ReviewPayload.event` when calling `vcs.postReview`. Adapters
   * that do not have a native review-event concept (CodeCommit)
   * ignore the field; the GitHub adapter uses it to switch the
   * underlying `pulls.createReview` event.
   */
  readonly reviewEvent: ReviewEvent;
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
