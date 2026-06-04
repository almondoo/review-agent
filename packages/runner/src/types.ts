import {
  type CATEGORIES,
  type Confidence,
  type InlineComment,
  REVIEW_ABORT_REASONS,
  type RequestChangesThreshold,
  type ReviewAbortReason,
  type ReviewEvent,
  type ReviewState,
  type SEVERITIES,
  type Severity,
  type Side,
} from '@review-agent/core';
import type { LlmProvider, ReviewInput, ReviewOutput } from '@review-agent/llm';
import type { GitleaksFinding } from './gitleaks.js';

/**
 * Mirrors `ConfigResolutionLog` from `@review-agent/config` (issue #146).
 * Declared here so `@review-agent/runner` does not need to depend on the
 * config package — TypeScript structural typing ensures the two types are
 * assignment-compatible. The canonical definition (with full JSDoc) lives
 * in `packages/config/src/loader.ts`.
 */
export type ConfigResolutionSource = 'repo-yaml' | 'org-yaml' | 'env' | 'default';

export type ConfigResolutionLog = {
  readonly primarySource: ConfigResolutionSource;
  readonly orgYamlLoaded: boolean;
  readonly envApplied: boolean;
  readonly sections: Readonly<Record<string, ConfigResolutionSource>>;
};

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
   * Operator-configured exclude globs from `.review-agent.yml`
   * `reviews.path_filters` (and any org-level config merged by
   * `loadConfigWithOrgFallback`). Files in the diff whose path
   * matches any pattern are dropped before the runner enforces the
   * `maxFiles` / `maxDiffLines` caps and before they enter the LLM
   * prompt (spec §10 L1435 — operator's "ignore this path tree"
   * lever). An empty list keeps every file in scope. Required so
   * the closed-world default is guaranteed at the type level — see
   * the matching closed-world pattern on `privacy.allowedUrlPrefixes`
   * / `privacy.denyPaths` / `privacy.redactPatterns`.
   */
  readonly pathFilters: ReadonlyArray<string>;
  /**
   * Hard cap on the number of files the runner will hand to the LLM
   * for a single review (`.review-agent.yml` `reviews.max_files`,
   * spec §10 L1449, default 50). When the post-`pathFilters` file
   * list exceeds this cap, the runner short-circuits the agent loop
   * — no LLM call, no cost — and surfaces an `aborted`-shape result
   * carrying an operator-facing skip notice. Required so the cap is
   * type-level guaranteed; the action / cli entry points thread
   * `config.reviews.max_files` into here.
   */
  readonly maxFiles: number;
  /**
   * Hard cap on the total number of diff lines (added + removed,
   * counted across every kept file's hunks) the runner will hand to
   * the LLM (`.review-agent.yml` `reviews.max_diff_lines`, spec §10
   * L1450, default 3000). Same short-circuit semantics as `maxFiles`:
   * an over-cap diff aborts the run without an LLM call and emits a
   * graceful skip summary. Required so the cap is type-level
   * guaranteed.
   */
  readonly maxDiffLines: number;
  /**
   * Privacy / data-flow policy for this job. Nested rather than
   * inlined so the three lists travel together and any future fields
   * can be threaded in without another schema migration. Current fields:
   *
   *   - `allowedUrlPrefixes`: closed-world URL allowlist consumed
   *     by `createReviewOutputSchema` (spec §7.3 #4 / §7.7).
   *   - `denyPaths`: operator-supplied glob deny list that the
   *     runner unions with the built-in `DENY_PATTERNS` and applies
   *     to every `read_file` / `glob` / `grep` dispatch (spec §7.4
   *     "extend, not relax").
   *   - `redactPatterns`: operator-supplied regex patterns that
   *     extend the gitleaks built-in ruleset in both the pre-prompt
   *     (diff) and post-LLM (output) scan passes (spec §7.4 / §7.7).
   *     Extend, never relax — built-in rules always run.
   *
   * All three fields are required so the closed-world defaults are
   * guaranteed at the type level.
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
    /**
     * Operator-supplied glob patterns from `.review-agent.yml`
     * `privacy.deny_paths` (and any org-level config merged in by
     * `loadConfigWithOrgFallback`). The runner compiles each entry
     * via `globToRegExp` and **unions** the result with the
     * built-in `DENY_PATTERNS` before every tool dispatch —
     * operators can extend the deny list but never shrink it
     * (spec §7.4 "extend, not relax"). An empty list keeps only
     * the built-in defaults active.
     */
    readonly denyPaths: ReadonlyArray<string>;
    /**
     * Operator-supplied regex patterns from `.review-agent.yml`
     * `privacy.redact_patterns` (and any org-level config merged
     * in by `loadConfigWithOrgFallback`). The runner lifts each
     * entry into a `[[rules]]` block in the temporary gitleaks
     * config (`custom-N`) and also feeds it to the in-process
     * `quickScanContent` fallback, so the operator's redaction
     * extends the gitleaks built-in ruleset on BOTH the pre-prompt
     * diff scan and the post-LLM output scan. Built-in rules
     * always run; this list never relaxes them (spec §7.4 "extend,
     * not relax"). Validated as compilable JS regexes at
     * `.review-agent.yml` load time (see `isValidRegex`).
     */
    readonly redactPatterns: ReadonlyArray<string>;
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
  /**
   * Per-category ruleset configuration. Declares which categories are
   * active and what the minimum severity floor is for each. The runner
   * applies this filter after dedup and min_confidence:
   *
   *   1. Findings with no category are assigned to `DEFAULT_RULESET_CATEGORY`
   *      so they are always subject to a deterministic policy (never silently
   *      dropped without a defined rule).
   *   2. Findings whose effective category has `enabled: false` are suppressed.
   *   3. Findings whose severity rank is strictly below `min_severity` for
   *      their effective category are suppressed.
   *
   * Optional for back-compat — callers that do not pass `ruleset` get the
   * no-op default (all categories enabled, min_severity='info' which is rank 0
   * and therefore never filters anything out).
   */
  readonly ruleset?: Readonly<
    Partial<
      Record<
        (typeof CATEGORIES)[number],
        { readonly enabled: boolean; readonly min_severity: (typeof SEVERITIES)[number] }
      >
    >
  >;
  /**
   * Inspectable record of which config source (repo YAML, org YAML,
   * env, or defaults) produced the effective config for this run.
   * Optional for back-compat — callers that do not use
   * `resolveEffectiveConfig` (issue #146) will not supply this field.
   *
   * When present, the runner fires `deps.onConfigResolution(log)` at
   * the start of the review so operators can log or record the
   * resolution for audit / reproducibility purposes.
   */
  readonly resolutionLog?: ConfigResolutionLog;
  /**
   * Maximum number of agent steps (LLM round-trips including tool-call
   * round-trips) for this review. Maps to `stopWhen: stepCountIs(N)` in
   * the AI SDK's `generateText` call. When absent, the runner falls back
   * to `MAX_TOOL_CALLS` (20) — preserving the hard-coded v0.x behaviour
   * for callers that pre-date this field. Configured via
   * `.review-agent.yml` `reviews.max_steps` (or `REVIEW_AGENT_MAX_STEPS`
   * env var when the YAML key is absent). Bounds: 1–50.
   */
  readonly maxSteps?: number;
  /**
   * Committable-suggestion gating (#152). Controls whether and for which
   * categories the runner forwards `suggestion` fields to the platform adapter.
   *
   * - `enabled: false` — all `suggestion` fields are stripped from every
   *   comment before posting; only the comment body reaches the VCS.
   * - `categories` — only comments whose `category` is in this list keep
   *   their suggestion. Comments in other categories have their suggestion
   *   field removed (body is preserved). Comments with no `category` field
   *   always keep their suggestion.
   *
   * Optional for back-compat — absent means no suggestion gating is applied
   * (suggestions flow to the adapter unchanged, subject only to the adapter's
   * hunk-validity check for GitHub).
   */
  readonly suggestions?: {
    readonly enabled: boolean;
    readonly categories: ReadonlyArray<(typeof CATEGORIES)[number]>;
  };
  /**
   * Large-PR / monorepo strategy (#158). Controls chunked multi-pass review
   * for PRs that exceed `maxFiles` / `maxDiffLines` caps.
   *
   * - `enabled: true` (default) — split the diff into chunks and review each
   *   chunk in sequence, up to `maxChunks`.
   * - `enabled: false` — preserve legacy skip behaviour (cap exceeded = no LLM).
   * - `maxChunks` — maximum number of chunks to review. Files that would fall
   *   in chunk N+1 are recorded in ExclusionReport with reason='max_chunks_exceeded'.
   * - `prioritization` — ordered criteria for ranking files before chunking.
   *
   * Optional for back-compat — absent is equivalent to `{ enabled: true, maxChunks: 5,
   * prioritization: ['path_instructions', 'diff_size'] }`.
   */
  readonly largePr?: {
    readonly enabled: boolean;
    readonly maxChunks: number;
    readonly prioritization: ReadonlyArray<'path_instructions' | 'diff_size' | 'alphabetical'>;
  };
  /**
   * External static-analysis tool findings to merge with the AI review (#160).
   * Each entry carries the SARIF file content (as a string) already read by
   * the entry point (action / cli). The runner normalises the SARIF, assigns
   * fingerprints, applies the same dedup / ruleset / suppression filters as AI
   * findings, and merges via `mergePolicy`.
   *
   * Optional for back-compat — absent (or empty array) keeps the existing
   * behaviour: only AI findings are posted (zero external injection).
   */
  readonly externalTools?: ReadonlyArray<{
    readonly name: string;
    readonly mergePolicy: 'tool_wins' | 'annotate' | 'ai_wins';
    readonly sarif: string;
  }>;
};

export type FinalizedComment = InlineComment & {
  readonly title?: string;
};

/**
 * Reasons the agent loop can give up on a review without posting any
 * inline comments. Two families share this discriminator:
 *
 * Schema-validation failures (spec §7.3 #4 retry-then-abort — the LLM
 * produced output that twice failed the response schema):
 *
 * - `url_allowlist`: the second-attempt output contained at least one
 *   URL that the closed-world allowlist refine rejected (the most
 *   common case for prompt-injected output).
 * - `schema_violation`: any other schema failure (broadcast mention,
 *   shell `curl http`, style-severity cap, etc.) survived the retry.
 *
 * Cap-skip pre-LLM short-circuits (spec §10 — `.review-agent.yml`
 * `reviews.max_files` / `reviews.max_diff_lines`). Both fire BEFORE
 * the gitleaks pre-scan and the LLM call so an over-size PR costs
 * nothing to refuse:
 *
 * - `max_files_exceeded`: the post-`path_filters` file count is
 *   greater than `job.maxFiles`.
 * - `max_diff_lines_exceeded`: the post-`path_filters` total `+`/`-`
 *   line count is greater than `job.maxDiffLines`.
 *
 * Surfaced on `RunnerResult.aborted.reason` so the caller (Action,
 * CLI) can pick a downstream behavior — at minimum, surface the
 * reason in the posted summary; eventually also gate state-comment
 * writes / cost reporting.
 */
export { REVIEW_ABORT_REASONS, type ReviewAbortReason };

/**
 * A file excluded from the review run before the LLM was called.
 * Populated by the cap pipeline in `runReview` for path-filter matches,
 * max_files overflows, and max_diff_lines overflows.
 */
export type ExcludedFile = {
  readonly path: string;
  /**
   * Human-readable reason for the exclusion. One of:
   * - `'path_filter'`         — matched a `reviews.path_filters` glob.
   * - `'max_files_cap'`       — diff exceeded `reviews.max_files`; this
   *                             file was part of the overflow.
   * - `'max_diff_lines_cap'`  — diff exceeded `reviews.max_diff_lines`;
   *                             this file was part of the overflow.
   * - `'max_chunks_exceeded'` — large_pr chunk limit reached; file was
   *                             in a chunk beyond `large_pr.max_chunks`.
   * - `'budget_exhausted'`    — cost cap (`cost.max_usd_per_pr`) was
   *                             reached mid-chunk-review; remaining files
   *                             were not reviewed.
   */
  readonly reason:
    | 'path_filter'
    | 'max_files_cap'
    | 'max_diff_lines_cap'
    | 'max_chunks_exceeded'
    | 'budget_exhausted';
};

/**
 * Report of all files that were excluded before the LLM was called.
 * Attached to `RunnerResult.exclusionReport` when at least one file
 * was excluded (path filter hit or cap exceeded). Optional for
 * back-compat — callers that pre-date #145 will not supply this field.
 *
 * The `capsApplied` field names which hard caps fired during this run:
 * - `max_files`       — the post-path-filter file count exceeded `maxFiles`.
 * - `max_diff_lines`  — the post-path-filter line count exceeded `maxDiffLines`.
 * - `max_chunks`      — large_pr chunk limit was reached.
 * - `budget_exhausted`— cost cap hit mid-chunk-review.
 * Multiple caps may be set simultaneously.
 */
export type ExclusionReport = {
  readonly excludedFiles: ReadonlyArray<ExcludedFile>;
  readonly capsApplied: ReadonlyArray<
    'max_files' | 'max_diff_lines' | 'max_chunks' | 'budget_exhausted'
  >;
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
   * Comments the dedup middleware suppressed because their
   * fingerprint matched a prior `factType: 'rejected_finding'` row
   * in `review_history` (spec §7.6, v1.2 epic #83 Phase 4 / #93).
   * Optional for back-compat — callers that don't wire a
   * `historyReader` get `undefined` rather than zero so eval
   * recorders can tell "feature off" from "feature on, no drops".
   */
  readonly droppedByFeedback?: number;
  /**
   * Comments suppressed by the `job.ruleset` filter (category disabled
   * or severity below the category's `min_severity` floor). Separated
   * from `droppedDuplicates` so the eval harness can measure ruleset
   * effectiveness independently from dedup. Zero when `job.ruleset` is
   * absent or the ruleset does not filter any comments.
   */
  readonly droppedByRuleset: number;
  /**
   * Comments skipped because their fingerprint matched an active
   * `suppression_rule` row in `review_history` (#155). Reported in the
   * run summary so operators can see the suppression effect. Optional
   * for back-compat — callers that do not wire a `suppressionLoader`
   * receive `undefined` rather than zero so eval recorders can tell
   * "feature off" from "feature on, no suppressions".
   */
  readonly droppedBySuppression?: number;
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
   * Files excluded before the LLM was called — path-filter matches and
   * max_files / max_diff_lines cap overflows. Present whenever at least
   * one file was excluded. Optional for back-compat: callers that pre-date
   * #145 will not supply this field and receive `undefined`. Consumers
   * (dry-run command, eval harness) should treat `undefined` as "no
   * exclusions recorded" rather than "no exclusions occurred".
   */
  readonly exclusionReport?: ExclusionReport;
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
  /**
   * Fired when `job.resolutionLog` is present, at the very start of
   * `runReview`, before any LLM call or gitleaks scan. Use this hook
   * to log or persist the effective-config resolution for audit /
   * reproducibility (issue #146 AC2). The runner does NOT call
   * `console.log` directly — all structured output flows through this
   * injected hook so callers control the destination (OTel, structured
   * logger, test spy, etc.).
   */
  readonly onConfigResolution?: (log: ConfigResolutionLog) => void;
  /**
   * General-purpose warn/info log sink. Used by the SARIF ingestion path
   * (#160) to surface skip/parse warnings (e.g. malformed SARIF, results
   * missing location) without writing to stdout/stderr directly. Optional
   * for back-compat — absent means SARIF warnings are silently discarded.
   */
  readonly logger?: (msg: string) => void;
  readonly fileReader?: (path: string) => Promise<string>;
  readonly fingerprintComment?: (c: {
    readonly path: string;
    readonly line: number;
    readonly side: Side;
    readonly severity: Severity;
    readonly body: string;
  }) => string;
  readonly scanContent?: (text: string) => ReadonlyArray<GitleaksFinding>;
  /**
   * Optional `wall-clock` provider for latency measurement. Defaults
   * to `Date.now`. Tests inject a deterministic clock so the
   * `latencyMs` field on the eval event is stable. Added in v1.2
   * epic #83 Phase 2.
   */
  readonly now?: () => number;
  /**
   * Per-review eval recorder (`review_eval_event` table, spec §7.6
   * adjacent). When both `evalRecorder` and `evalContext` are
   * provided, the runner builds a `ReviewEvalEvent` from the final
   * `RunnerResult` and calls the recorder once at the very end of
   * `runReview`. Insert errors are caught fail-open so a transient
   * DB issue never aborts a successfully-posted review. v1.2 epic
   * #83 Phase 2.
   */
  readonly evalRecorder?: import('@review-agent/core').ReviewEvalEventRecorder;
  readonly evalContext?: {
    readonly installationId: bigint;
    readonly prNumber: number;
    readonly headSha: string;
  };
  /**
   * Fired when the eval recorder throws. The runner does NOT
   * re-throw — operators who want observability route this to OTel
   * or their logger here.
   */
  readonly onEvalRecordError?: (err: unknown) => void;
  /**
   * v1.2 #106. Fired when `historyReader` (Phase 4 / #93) throws.
   * The runner **does** re-throw — the historyReader failure is
   * operator-visible per the v1.2 design (see `agent.ts`). The hook
   * exists so operators can route the error to a counter
   * (`review_agent_history_reader_errors_total`) before the cascading
   * review failure surfaces to the queue.
   */
  readonly onHistoryReaderError?: (err: unknown) => void;
  /**
   * Optional reader that loads `review_history` rows for this PR's
   * repo (v1.2 epic #83 Phase 4 / #93). When present the runner
   * splits the rows into:
   *   - `rejected_finding` rows -> `rejectedFingerprints` for the
   *     dedup middleware (post-LLM backstop).
   *   - All rows -> `<learned_facts>` section in the system prompt.
   *
   * `installationId` + `repo` are derived from `evalContext.installationId`
   * and `job.prRepo`; the reader returns up to `MAX_LEARNED_FACTS`
   * rows ordered desc by `created_at`.
   */
  readonly historyReader?: (q: {
    readonly installationId: bigint;
    readonly repo: string;
    readonly limit: number;
  }) => Promise<
    ReadonlyArray<{
      readonly factType: 'accepted_pattern' | 'rejected_finding' | 'arch_decision';
      readonly factText: string;
    }>
  >;
  /**
   * #155 false-positive suppression: loads active `suppression_rule` rows
   * for the PR's repo. The runner extracts fingerprints from the `factText`
   * values and drops any finding whose fingerprint matches, before the
   * findings reach the output scan or `postReview`. When absent, suppression
   * is disabled for this run (back-compat).
   */
  readonly suppressionLoader?: (q: {
    readonly installationId: bigint;
    readonly repo: string;
  }) => Promise<ReadonlyArray<{ readonly factText: string }>>;
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
