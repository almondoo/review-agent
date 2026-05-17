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
  /**
   * Privacy / data-flow policy for this job. Nested rather than
   * inlined so future fields from `.review-agent.yml` `privacy.*`
   * (e.g. `deny_paths`, `redact_patterns`) can be threaded in
   * without another schema migration. The current single field is
   * the URL allowlist consumed by `createReviewOutputSchema`
   * (spec §7.3 #4 / §7.7).
   */
  readonly privacy: {
    /**
     * Whitelisted URL prefixes from `.review-agent.yml`
     * `privacy.allowed_url_prefixes`. The runner forwards this
     * directly into `createReviewOutputSchema({ allowedUrlPrefixes })`.
     * An empty list keeps the closed-world default — only links
     * into the PR's own repo (see `prRepo`) are permitted.
     */
    readonly allowedUrlPrefixes: ReadonlyArray<string>;
  };
  /**
   * The PR's own repository, used by the URL allowlist refine to
   * grant `<host>/<owner>/<repo>/...` links permanent allowlist
   * status (spec §7.3 #4 "PR's own repo"). Host is required —
   * callers derive it from `GITHUB_SERVER_URL` (Action) or the
   * webhook installation host (Server) so GHES deployments work
   * uniformly without a code change.
   */
  readonly prRepo: {
    readonly host: string;
    readonly owner: string;
    readonly repo: string;
  };
};

export type FinalizedComment = InlineComment & {
  readonly title?: string;
};

/**
 * Reasons the agent loop can give up on a review after schema
 * validation fails twice in a row (spec §7.3 #4 retry-then-abort).
 *
 * - `url_allowlist`: the second-attempt output contained at least one
 *   URL that the closed-world allowlist refine rejected (the most
 *   common case for prompt-injected output).
 * - `schema_violation`: any other schema failure (broadcast mention,
 *   shell `curl http`, style-severity cap, etc.) survived the retry.
 *
 * Surfaced on `RunnerResult.aborted.reason` so the caller (Action,
 * CLI) can pick a downstream behavior — at minimum, surface the
 * reason in the posted summary; eventually also gate state-comment
 * writes / cost reporting.
 */
export const REVIEW_ABORT_REASONS = ['url_allowlist', 'schema_violation'] as const;
export type ReviewAbortReason = (typeof REVIEW_ABORT_REASONS)[number];

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
  /**
   * Set when the agent loop gracefully aborted (spec §7.3 #4): the
   * LLM produced output that failed the response schema twice — once
   * on the first attempt and again on the retry that injects the
   * corrective prompt. `comments` will be empty and `summary` will
   * carry the operator-facing abort notice. Callers that need to
   * distinguish "no findings" from "we gave up" should check this
   * field rather than `comments.length === 0`.
   *
   * `internalIssues` carries the raw Zod issue list from the second
   * failure for **internal use only** (audit log, telemetry, server
   * stdout, debugger). It MUST NOT be echoed into any user-facing
   * channel (PR comment, summary post, public CLI stdout) because
   * the rejected URL message can include attacker-injected secrets
   * — e.g. `?token=...` query strings that the URL allowlist
   * specifically blocked from being clickable, and posting them
   * verbatim in a public comment would reopen the exfiltration
   * channel. The `summary` field is the only string safe to publish.
   */
  readonly aborted?: {
    readonly reason: ReviewAbortReason;
    readonly internalIssues: ReadonlyArray<{
      readonly path: string;
      readonly message: string;
    }>;
  };
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
