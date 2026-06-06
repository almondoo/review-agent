import {
  type Category,
  CONFIDENCES,
  type Confidence,
  CostExceededError,
  computeReviewEvent,
  createReviewOutputSchema,
  fingerprint as defaultFingerprint,
  globToRegExp,
  SchemaValidationError,
  SEVERITY_RANK,
  SecretLeakAbortedError,
  type Severity,
  URL_ALLOWLIST_ISSUE_PREFIX,
} from '@review-agent/core';
import type { LlmProvider, ReviewInput, ReviewOutput } from '@review-agent/llm';
import { collectAutoFetchContext } from './auto-fetch.js';
import {
  applyPathFilters,
  countDiffLines,
  type ParsedDiff,
  parseDiffByFile,
  reassembleDiff,
  sortByPrioritization,
  splitIntoChunks,
} from './diff-filter.js';
import {
  applyRedactions,
  type GitleaksFinding,
  quickScanContent,
  shouldAbortReview,
} from './gitleaks.js';
import {
  type CostState,
  createCostGuard,
  createInjectionGuard,
  dedupComments,
  recordEvalEvent,
} from './middleware/index.js';
import { composeSystemPrompt, MAX_LEARNED_FACTS } from './prompts/system-prompt.js';
import { wrapUntrusted } from './prompts/untrusted.js';
import { parseSarif } from './sarif.js';
import { createAiSdkToolset, MAX_TOOL_CALLS, type ToolName } from './tools.js';
import type {
  ExcludedFile,
  ExclusionReport,
  Middleware,
  MiddlewareCtx,
  ReviewAbortReason,
  ReviewJob,
  RunnerResult,
  RunReviewDeps,
} from './types.js';

const RETRY_PROMPT_SUFFIX =
  '\n\nIMPORTANT: your previous response failed schema validation. Produce strictly valid output that matches the configured schema.';

/**
 * Default category assigned to findings that carry no `category` field.
 * Findings without a category are always assigned this value before the
 * ruleset filter runs, so every finding is subject to a deterministic
 * policy (never silently dropped without a defined rule — spec §10.1).
 *
 * `'bug'` is the documented default: a finding without a category is
 * most likely a correctness issue (the most conservative assumption).
 * This constant is exported so tests can assert the documented default
 * without hard-coding the string.
 */
export const DEFAULT_RULESET_CATEGORY: Category = 'bug';

/**
 * Operator-facing summary text for the two retry-then-abort cases
 * (spec §7.3 #4). English is hard-coded per CLAUDE.md "internal
 * prompts / system-facing strings are always English" rule; the
 * post-translation language-aware summary is the caller's
 * responsibility once a feature exists for it.
 */
const URL_ALLOWLIST_ABORT_SUMMARY =
  'Review aborted: LLM produced output that violates the URL allowlist after one retry. See spec §7.3.';
const SCHEMA_ABORT_SUMMARY =
  'Review aborted: LLM produced output that fails schema validation after one retry. See spec §7.3.';

/**
 * Operator-facing summary text for the two pre-LLM cap-skip cases
 * (spec §10 `.review-agent.yml` `reviews.max_files` /
 * `reviews.max_diff_lines`). Only numeric counts and operator-set
 * limits are interpolated — no file paths, hunk contents, or URLs
 * — so the resulting string is safe to post verbatim to a public
 * PR comment without re-introducing prompt-injection or
 * exfiltration surface (mirrors the audit / output-only-summary
 * discipline pinned by spec §7.3 #4 and #87).
 */
function maxFilesSkipSummary(fileCount: number, cap: number): string {
  return `Review skipped: PR exceeds the max_files cap (${fileCount} files > limit ${cap}). Adjust reviews.max_files in .review-agent.yml or reduce PR scope.`;
}
function maxDiffLinesSkipSummary(lineCount: number, cap: number): string {
  return `Review skipped: PR exceeds the max_diff_lines cap (${lineCount} lines > limit ${cap}). Adjust reviews.max_diff_lines in .review-agent.yml or reduce PR scope.`;
}

/**
 * Build the `RunnerResult` returned by the cap-skip short-circuits.
 * The shape mirrors the schema-abort path (`comments: []` +
 * `aborted.{reason, internalIssues}`) so existing callers
 * (`postOrUpdate` in action / cli) need no branching to handle it.
 *
 * Cost / tokens / tool-calls are all zero by construction — the
 * cap fires before the gitleaks pre-scan, before auto-fetch, and
 * before any `provider.generateReview` call, so the cost-guard
 * middleware never even runs. `reviewEvent` is hard-coded to
 * `'COMMENT'` because zero kept comments cannot drive
 * `REQUEST_CHANGES`.
 *
 * `internalIssues` is an empty list for cap-skips. The
 * operator-facing reason already lives in `summary` (which is the
 * only string that may be posted to a PR), and there are no raw
 * Zod issues to carry through — the audit trail for cap-skip is
 * the `reason` discriminator plus the counts already embedded in
 * `summary`.
 */
function buildCapSkipResult(
  provider: LlmProvider,
  reason: ReviewAbortReason,
  summary: string,
  exclusionReport: ExclusionReport,
  filesTotal: number,
): RunnerResult {
  return {
    comments: [],
    summary,
    costUsd: 0,
    tokensUsed: { input: 0, output: 0 },
    model: provider.model,
    provider: provider.name,
    droppedDuplicates: 0,
    droppedByRuleset: 0,
    toolCalls: 0,
    reviewEvent: 'COMMENT',
    aborted: { reason, internalIssues: [] },
    exclusionReport,
    filesTotal,
    filesReviewed: 0,
  };
}

/**
 * Build the operator-facing coverage summary for chunked large-PR reviews
 * (#158). Describes how many files were reviewed, in how many chunks, and
 * which files were skipped and why. Posted as part of the PR summary so
 * operators know the review was partial (AC#3: no silent truncation).
 *
 * Only non-empty exclusion groups are included in the message so the
 * output reads cleanly for the common case where only one skip reason applies.
 */
function buildChunkCoverageSummary(
  reviewedCount: number,
  chunkCount: number,
  excludedFiles: ReadonlyArray<ExcludedFile>,
): string {
  const maxChunksFiles = excludedFiles
    .filter((f) => f.reason === 'max_chunks_exceeded')
    .map((f) => f.path);
  const budgetFiles = excludedFiles
    .filter((f) => f.reason === 'budget_exhausted')
    .map((f) => f.path);
  const pathFilterFiles = excludedFiles
    .filter((f) => f.reason === 'path_filter')
    .map((f) => f.path);

  const parts: string[] = [
    `Large-PR review: reviewed ${reviewedCount} file${reviewedCount !== 1 ? 's' : ''} across ${chunkCount} chunk${chunkCount !== 1 ? 's' : ''}.`,
  ];
  if (maxChunksFiles.length > 0) {
    parts.push(
      `Skipped ${maxChunksFiles.length} file${maxChunksFiles.length !== 1 ? 's' : ''} (max_chunks_exceeded — increase large_pr.max_chunks to review more).`,
    );
  }
  if (budgetFiles.length > 0) {
    parts.push(
      `Skipped ${budgetFiles.length} file${budgetFiles.length !== 1 ? 's' : ''} (budget_exhausted — cost cap reached mid-review).`,
    );
  }
  if (pathFilterFiles.length > 0) {
    parts.push(
      `Skipped ${pathFilterFiles.length} file${pathFilterFiles.length !== 1 ? 's' : ''} (path_filter).`,
    );
  }
  return parts.join(' ');
}

/**
 * Decide which abort path a `SchemaValidationError` belongs to. URL
 * allowlist failures are diagnostically distinct (operators want to
 * see "your model is leaking links" vs. "your model is breaking
 * shape") so the summary text and the `aborted.reason` discriminator
 * branch on the issue message prefix produced by `schemas.ts`.
 */
function classifyAbort(err: SchemaValidationError): {
  reason: ReviewAbortReason;
  summary: string;
} {
  if (err.issues.some((i) => i.message.startsWith(URL_ALLOWLIST_ISSUE_PREFIX))) {
    return { reason: 'url_allowlist', summary: URL_ALLOWLIST_ABORT_SUMMARY };
  }
  return { reason: 'schema_violation', summary: SCHEMA_ABORT_SUMMARY };
}

/**
 * Apply the operator's `ruleset` configuration to the kept comment list.
 * Three-step pipeline:
 *
 *   1. Assign `DEFAULT_RULESET_CATEGORY` to any comment whose `category`
 *      field is absent or undefined, so every finding is subject to a
 *      deterministic policy (never silently dropped without a defined rule).
 *   2. Suppress findings whose effective category has `enabled: false`.
 *   3. Suppress findings whose `severity` rank is strictly below the
 *      `min_severity` floor configured for their effective category.
 *
 * When `ruleset` is absent or empty (`{}`), no filtering is applied and
 * the function returns the input list unchanged (zero cost).
 */
function applyRulesetFilter(
  comments: ReadonlyArray<import('@review-agent/core').InlineComment>,
  ruleset: ReviewJob['ruleset'],
): { kept: ReadonlyArray<import('@review-agent/core').InlineComment>; dropped: number } {
  if (!ruleset || Object.keys(ruleset).length === 0) {
    return { kept: comments, dropped: 0 };
  }
  let dropped = 0;
  const kept: Array<import('@review-agent/core').InlineComment> = [];
  for (const comment of comments) {
    // Step 1: assign default category when absent.
    const effectiveCategory: Category = comment.category ?? DEFAULT_RULESET_CATEGORY;
    const entry = ruleset[effectiveCategory];
    // No entry for this category → no filtering (default pass).
    if (entry === undefined) {
      kept.push(comment);
      continue;
    }
    // Step 2: suppress disabled categories.
    if (!entry.enabled) {
      dropped += 1;
      continue;
    }
    // Step 3: suppress below min_severity floor.
    const commentRank = SEVERITY_RANK[comment.severity as Severity];
    const floorRank = SEVERITY_RANK[entry.min_severity as Severity];
    if (commentRank < floorRank) {
      dropped += 1;
      continue;
    }
    kept.push(comment);
  }
  return { kept, dropped };
}

/**
 * Ingest external SARIF tool findings, apply dedup/ruleset/suppression filters
 * (same pipeline as AI findings), then merge with the AI comment list using
 * the per-tool `mergePolicy` (#160).
 *
 * Merge policy semantics (applied per-tool, in order):
 *   - `tool_wins`:  fingerprint collision → keep external, drop AI duplicate.
 *   - `ai_wins`:    fingerprint collision → keep AI, drop external duplicate.
 *   - `annotate`:   fingerprint collision → keep AI, append annotation to its
 *                   body; drop external duplicate. Non-conflicting external
 *                   findings are added.
 *
 * `previousFingerprints` is the set of fingerprints from *prior reviews*
 * (previousState.commentFingerprints). External findings already posted in a
 * previous review are dedup'd out. The *current-run* AI fingerprints are NOT
 * in this set — those are handled via merge-policy conflict resolution, not
 * dedup, so external findings matching current-run AI findings reach the policy
 * logic rather than being silently dropped.
 *
 * When `job.externalTools` is absent/empty the function returns `aiComments`
 * unchanged (zero overhead, complete back-compat).
 */
function mergeExternalFindings(
  job: ReviewJob,
  aiComments: ReadonlyArray<import('@review-agent/core').InlineComment>,
  previousFingerprints: ReadonlySet<string>,
  rejectedFingerprints: ReadonlyArray<string>,
  suppressedFingerprints: ReadonlyArray<string>,
  warnLog: (msg: string) => void,
): ReadonlyArray<import('@review-agent/core').InlineComment> {
  if (!job.externalTools || job.externalTools.length === 0) return aiComments;

  const rejected = new Set(rejectedFingerprints);
  const suppressed = new Set(suppressedFingerprints);

  // Start with a mutable copy of the AI comment list.
  const merged: Array<import('@review-agent/core').InlineComment> = [...aiComments];

  for (const toolConfig of job.externalTools) {
    const { name, mergePolicy, findings, warnings } = parseSarif(
      toolConfig.name,
      toolConfig.mergePolicy,
      toolConfig.sarif,
    );

    for (const w of warnings) warnLog(w);

    // Assign fingerprints to external findings and apply dedup/ruleset/suppression.
    const fingerprintedFindings: Array<import('@review-agent/core').InlineComment> = [];
    for (const finding of findings) {
      const fp = defaultFingerprint({
        path: finding.path,
        line: finding.line,
        ruleId: finding.ruleId ?? finding.severity,
        suggestionType: 'comment',
      });

      // Skip if already posted in a previous review or rejected by feedback.
      // Do NOT skip on current-run AI fingerprints — those are handled below
      // via merge-policy conflict resolution.
      if (rejected.has(fp) || previousFingerprints.has(fp)) continue;

      fingerprintedFindings.push({ ...finding, fingerprint: fp });
    }

    // Apply ruleset filter.
    const rulesetResult = applyRulesetFilter(fingerprintedFindings, job.ruleset);

    // Apply suppression filter.
    const afterSuppression =
      suppressed.size === 0
        ? rulesetResult.kept
        : rulesetResult.kept.filter((c) => !suppressed.has(c.fingerprint));

    // Apply merge policy.
    for (const extFinding of afterSuppression) {
      const fp = extFinding.fingerprint;
      const aiConflictIdx = merged.findIndex((c) => c.fingerprint === fp);

      if (aiConflictIdx === -1) {
        // No conflict: add external finding unconditionally.
        merged.push(extFinding);
      } else if (mergePolicy === 'tool_wins') {
        // Replace AI duplicate with external finding.
        merged.splice(aiConflictIdx, 1, extFinding);
      } else if (mergePolicy === 'ai_wins') {
        // Keep AI; drop external duplicate (do nothing).
      } else {
        // annotate: append note to AI comment body, drop external duplicate.
        const ai = merged[aiConflictIdx];
        if (ai) {
          const ruleNote = extFinding.ruleId ? ` (\`${extFinding.ruleId}\`)` : '';
          merged[aiConflictIdx] = {
            ...ai,
            body: `${ai.body}\n\n_Also flagged by ${name}${ruleNote}_`,
          };
        }
      }
    }
  }

  return merged;
}

async function runReviewInner(
  job: ReviewJob,
  provider: LlmProvider,
  deps: RunReviewDeps,
): Promise<RunnerResult> {
  // Fire the config resolution hook before any LLM call or gitleaks
  // scan. This gives callers (action, server, CLI) an opportunity to
  // log the effective-config provenance per-run for audit and
  // reproducibility (issue #146 AC2). The hook is optional — callers
  // that do not supply `onConfigResolution` or do not pass
  // `resolutionLog` on the job simply skip this block.
  if (job.resolutionLog !== undefined && deps.onConfigResolution !== undefined) {
    deps.onConfigResolution(job.resolutionLog);
  }

  // Incremental review fields flow from the action / cli call site
  // (see packages/action/src/run.ts where computeDiffStrategy decides
  // sinceSha). When the diff is incremental, the system prompt warns
  // the LLM not to re-flag findings from outside the new commits, and
  // surfaces the previous review's fingerprints so the model can avoid
  // duplicate work upstream of the dedup post-filter.
  const previousFingerprints = job.previousState?.commentFingerprints ?? [];
  const promptOptions: Parameters<typeof composeSystemPrompt>[0] = {
    profile: job.profile,
    skills: job.skills,
    pathInstructions: job.pathInstructions,
    language: job.language,
    summaryConfig: {
      walkthrough: job.summary?.walkthrough ?? true,
      changeImpact: job.summary?.changeImpact ?? true,
      dependencyView: job.summary?.dependencyView ?? false,
    },
  };
  if (job.incrementalContext === true) {
    (promptOptions as { incrementalContext?: boolean }).incrementalContext = true;
    if (job.incrementalSinceSha !== undefined) {
      (promptOptions as { incrementalSinceSha?: string }).incrementalSinceSha =
        job.incrementalSinceSha;
    }
  }
  if (previousFingerprints.length > 0) {
    (promptOptions as { previousFingerprints?: ReadonlyArray<string> }).previousFingerprints =
      previousFingerprints;
  }

  // v1.2 epic #83 Phase 4 / #93 — load `review_history` for this
  // repo (when an `evalContext` + `historyReader` are wired), then
  // split the rows into:
  //   - `<learned_facts>` for the system prompt (every factType).
  //   - `rejectedFingerprints` extracted from `[fp:<fp>] ...` text
  //     of `rejected_finding` rows, for the dedup middleware's
  //     post-LLM backstop.
  // Failures bubble up — a transient DB outage in the reader is
  // operator-visible and the operator decides whether to fall back
  // to a no-history review or surface the error. We do NOT silently
  // skip the section on read failure, because that would erase the
  // learning signal without warning.
  let learnedFacts: ReadonlyArray<{
    readonly factType: 'accepted_pattern' | 'rejected_finding' | 'arch_decision';
    readonly factText: string;
  }> = [];
  let rejectedFingerprints: ReadonlyArray<string> = [];
  if (deps.historyReader && deps.evalContext) {
    let rows: Awaited<ReturnType<NonNullable<typeof deps.historyReader>>>;
    try {
      rows = await deps.historyReader({
        installationId: deps.evalContext.installationId,
        repo: normalizeRepoKey(job.prRepo, deps.evalContext.installationId),
        limit: MAX_LEARNED_FACTS,
      });
    } catch (err) {
      // v1.2 #106: fire the observability hook before re-raising so the
      // counter sees the error even though the existing behavior of
      // bubbling the failure to the queue is preserved.
      deps.onHistoryReaderError?.(err);
      throw err;
    }
    learnedFacts = rows;
    rejectedFingerprints = rows
      .filter((r) => r.factType === 'rejected_finding')
      .map((r) => extractFingerprint(r.factText))
      .filter((fp): fp is string => fp !== null);
  }
  if (learnedFacts.length > 0) {
    (promptOptions as { learnedFacts?: typeof learnedFacts }).learnedFacts = learnedFacts;
  }

  // #155 false-positive suppression: load active suppression_rule rows for
  // this repo. The runner applies these after dedup + confidence + ruleset
  // filters to drop findings whose fingerprint is muted. Failures bubble up
  // (same rationale as historyReader above — operator-visible transient DB
  // errors must not silently skip suppression enforcement).
  let suppressedFingerprints: ReadonlyArray<string> = [];
  if (deps.suppressionLoader && deps.evalContext) {
    const suppressionRows = await deps.suppressionLoader({
      installationId: deps.evalContext.installationId,
      repo: normalizeRepoKey(job.prRepo, deps.evalContext.installationId),
    });
    suppressedFingerprints = suppressionRows
      .map((r) => extractFingerprint(r.factText))
      .filter((fp): fp is string => fp !== null);
  }

  const systemPrompt = composeSystemPrompt(promptOptions);
  const fileReader = deps.fileReader ?? (async () => '');
  // Bind the operator's `privacy.redact_patterns` into the default
  // scanner so the diff pre-scan and the LLM-output post-scan both
  // run built-in detectors AND the custom regex set in one pass
  // (spec §7.4). `deps.scanContent` injection still wins for tests
  // — those callers either include any custom patterns themselves
  // or deliberately scope the scan to a fixed corpus.
  const customRedactPatterns = job.privacy.redactPatterns;
  const scanContent =
    deps.scanContent ?? ((text: string) => quickScanContent(text, customRedactPatterns));

  // Cap pipeline (spec §10) — runs BEFORE the gitleaks pre-scan and
  // before the LLM call so an over-size PR costs nothing to refuse.
  //
  // Order of operations:
  //   1. parseDiffByFile  — split job.diffText into per-file segments
  //   2. applyPathFilters — drop files matching reviews.path_filters
  //                         (exclude semantics, spec §10 L1435)
  //   3. max_files cap    — skip if filtered.files.length > maxFiles
  //   4. max_diff_lines   — skip if countDiffLines(filtered) > cap
  //
  // Caps fire BEFORE secret scanning. Rationale: an operator who
  // configured `max_files: 50` is asking "don't even look at PRs
  // bigger than this." Scanning a 5000-file PR for secrets, only to
  // then skip the LLM call, would burn gitleaks CPU and run a
  // `SecretLeakAbortedError` exit path that surfaces a finding the
  // operator already opted out of acting on. The cap-skip path
  // returns `aborted.reason = 'max_files_exceeded'` /
  // `'max_diff_lines_exceeded'` instead — the operator sees the
  // size signal, and the secret-scan budget is preserved for PRs
  // that will actually go through the LLM. Test
  // `runReview — reviews.{max_files,max_diff_lines} caps` pins
  // both this priority and the cost-zero invariant.
  //
  // `applyPathFilters` returns the same reference when no file
  // matched any filter (or filters is empty). We use that as the
  // "is the diff payload unchanged?" check: when nothing was
  // dropped, the downstream code paths see `job.diffText` and
  // `job.changedPaths` exactly as upstream sent them. Only when a
  // file was actually filtered out do we reassemble the diff (so
  // the LLM and the diff pre-scan never see the excluded content)
  // and shrink `changedPaths` (so `collectAutoFetchContext` does
  // not pull companion files for paths the operator excluded —
  // path_filters is a "ignore this path tree entirely" lever, not
  // a "still fetch siblings but hide the change" one).
  const parsedDiff = parseDiffByFile(job.diffText);
  const filteredDiff = applyPathFilters(parsedDiff, job.pathFilters);

  // Collect files removed by path_filters so they appear in the
  // exclusionReport regardless of whether a cap also fires.
  const pathFilterExclusions: ReadonlyArray<ExcludedFile> =
    filteredDiff !== parsedDiff
      ? parsedDiff.files
          .filter((f) => !filteredDiff.files.some((kf) => kf.path === f.path))
          .map((f) => ({ path: f.path, reason: 'path_filter' as const }))
      : [];

  // large_pr defaults: enabled=true, max_chunks=5, prioritization=['path_instructions','diff_size']
  const largePrConfig = job.largePr ?? {
    enabled: true,
    maxChunks: 5,
    prioritization: ['path_instructions', 'diff_size'] as const,
  };

  const exceedsFiles = filteredDiff.files.length > job.maxFiles;
  const diffLineCount = countDiffLines(filteredDiff);
  const exceedsLines = diffLineCount > job.maxDiffLines;
  const capsExceeded = exceedsFiles || exceedsLines;

  // Legacy skip path: largePr.enabled === false (or caps not exceeded).
  if (capsExceeded && !largePrConfig.enabled) {
    if (exceedsFiles) {
      const capExclusions: ReadonlyArray<ExcludedFile> = filteredDiff.files.map((f) => ({
        path: f.path,
        reason: 'max_files_cap' as const,
      }));
      const exclusionReport: ExclusionReport = {
        excludedFiles: [...pathFilterExclusions, ...capExclusions],
        capsApplied: ['max_files'],
      };
      return buildCapSkipResult(
        provider,
        'max_files_exceeded',
        maxFilesSkipSummary(filteredDiff.files.length, job.maxFiles),
        exclusionReport,
        filteredDiff.files.length,
      );
    }
    // exceedsLines must be true here.
    const capExclusions: ReadonlyArray<ExcludedFile> = filteredDiff.files.map((f) => ({
      path: f.path,
      reason: 'max_diff_lines_cap' as const,
    }));
    const exclusionReport: ExclusionReport = {
      excludedFiles: [...pathFilterExclusions, ...capExclusions],
      capsApplied: ['max_diff_lines'],
    };
    return buildCapSkipResult(
      provider,
      'max_diff_lines_exceeded',
      maxDiffLinesSkipSummary(diffLineCount, job.maxDiffLines),
      exclusionReport,
      filteredDiff.files.length,
    );
  }

  // Shared per-job cost state — created before any chunk iteration so the
  // cost guard accumulates across all chunks and enforces max_usd_per_pr
  // as a PR-level cap (not a per-chunk cap).
  const costState: CostState = { totalCostUsd: 0 };

  // Compile deny patterns and create the toolset once — reused across chunks.
  const denyPatterns: ReadonlyArray<RegExp> = job.privacy.denyPaths.map((g) => globToRegExp(g));
  let toolCallCounter = 0;
  const tools = createAiSdkToolset({
    workspace: job.workspaceDir,
    denyPatterns,
    onCall: (_name: ToolName) => {
      toolCallCounter += 1;
    },
  });

  // Build the per-job factory schema once — reused for both attempts of each chunk.
  const outputSchema = createReviewOutputSchema({
    allowedUrlPrefixes: job.privacy.allowedUrlPrefixes,
    prRepo: job.prRepo,
  });

  const effectiveMaxSteps = job.maxSteps ?? MAX_TOOL_CALLS;

  /**
   * Run a single diff payload through the LLM pipeline. Used by both the
   * single-pass path (no chunking) and each iteration of the chunk loop.
   *
   * Takes a pre-assembled `diffPayload` string (wrappedMetadata + diffText)
   * and returns the raw `ReviewOutput` from the provider, after gitleaks
   * diff pre-scan. The caller is responsible for dedup / filters / post-scan.
   *
   * The `costState` is shared across all invocations so cost accumulates
   * correctly across chunks.
   */
  const runSinglePass = async (diffPayload: string): Promise<ReviewOutput> => {
    const middlewares: ReadonlyArray<Middleware> = [
      createInjectionGuard(),
      createCostGuard({
        state: costState,
        ...(deps.onThresholdCrossed !== undefined
          ? { onThresholdCrossed: deps.onThresholdCrossed }
          : {}),
        ...(deps.budgetAlertUsd !== undefined ? { budgetAlertUsd: deps.budgetAlertUsd } : {}),
      }),
    ];

    const baseInput: ReviewInput = {
      systemPrompt,
      diffText: diffPayload,
      prMetadata: job.prMetadata,
      fileReader,
      language: job.language,
      tools,
      maxToolCalls: effectiveMaxSteps,
    };

    const ctx: MiddlewareCtx = { job, input: baseInput, provider };
    const main = async (): Promise<ReviewOutput> => {
      try {
        const out = await provider.generateReview(ctx.input);
        validateOutput(outputSchema, out);
        return out;
      } catch (err) {
        if (!(err instanceof SchemaValidationError)) throw err;
        const retried = await provider.generateReview({
          ...ctx.input,
          systemPrompt: ctx.input.systemPrompt + RETRY_PROMPT_SUFFIX,
        });
        validateOutput(outputSchema, retried);
        return retried;
      }
    };

    return compose(middlewares, ctx, main);
  };

  /**
   * Assemble a `diffPayload` string (wrappedMetadata + diffText) for a given
   * chunk (ParsedDiff). Runs auto-fetch for the chunk's changed paths.
   */
  const buildDiffPayload = async (
    chunkDiff: ParsedDiff,
  ): Promise<{
    readonly diffPayload: string;
    readonly changedPaths: ReadonlyArray<string>;
  }> => {
    const chunkDiffText = reassembleDiff(chunkDiff);
    const chunkChangedPaths = chunkDiff.files.map((f) => f.path);

    const diffFindings = [...scanContent(chunkDiffText)];
    const diffDecision = shouldAbortReview(diffFindings);
    if (diffDecision.abort) {
      throw new SecretLeakAbortedError(
        'diff',
        diffFindings.length,
        uniqueRuleIds(diffFindings),
        diffDecision.reason ?? 'unknown',
      );
    }

    const autoFetch = await collectAutoFetchContext({
      changedPaths: chunkChangedPaths,
      pathInstructions: job.pathInstructions,
      workspaceDir: job.workspaceDir,
      denyPatterns,
    });
    const wrappedMetadata = wrapUntrusted(job.prMetadata, {
      files: autoFetch.files,
      hitBudgetLimit: autoFetch.hitBudgetLimit,
      totalBytes: autoFetch.totalBytes,
    });
    return {
      diffPayload: `${wrappedMetadata}\n\n${chunkDiffText}`,
      changedPaths: chunkChangedPaths,
    };
  };

  /**
   * Apply post-LLM filters (dedup, confidence, ruleset, suppression,
   * suggestion gating, secret scan) to a raw `ReviewOutput` and return the
   * final comment list + summary + per-pass accounting.
   *
   * `seenFingerprints` is a mutable Set that accumulates across chunks for
   * cross-chunk dedup. On entry it contains previous-state fingerprints +
   * all fingerprints emitted by earlier chunks. On return the set has been
   * extended with the fingerprints of comments kept in this pass.
   */
  const applyPostLlmFilters = (
    result: ReviewOutput,
    seenFingerprints: Set<string>,
  ): {
    readonly comments: ReadonlyArray<import('@review-agent/core').InlineComment>;
    readonly summary: string;
    readonly droppedDuplicates: number;
    readonly droppedByFeedback: number;
    readonly droppedByRuleset: number;
    readonly droppedBySuppression: number;
    readonly toolCalls: number;
  } => {
    const dedup = dedupComments(result, {
      // Pass a synthetic previousState whose commentFingerprints is the
      // cross-chunk accumulated set so subsequent chunks don't re-emit
      // findings already emitted in earlier chunks.
      previousState: {
        schemaVersion: 1,
        lastReviewedSha: '',
        baseSha: '',
        reviewedAt: '',
        modelUsed: '',
        totalTokens: 0,
        totalCostUsd: 0,
        commentFingerprints: [...seenFingerprints],
      },
      rejectedFingerprints,
    });

    // Extend the shared set with this chunk's kept fingerprints.
    for (const c of dedup.kept) seenFingerprints.add(c.fingerprint);

    const minConfidence = job.minConfidence ?? 'low';
    const afterConfidence = dedup.kept.filter((c) => meetsConfidence(c.confidence, minConfidence));

    const rulesetResult = applyRulesetFilter(afterConfidence, job.ruleset);

    const suppressionSet = new Set(suppressedFingerprints);
    let droppedBySuppression = 0;
    const afterSuppression =
      suppressionSet.size === 0
        ? rulesetResult.kept
        : rulesetResult.kept.filter((c) => {
            if (suppressionSet.has(c.fingerprint)) {
              droppedBySuppression += 1;
              return false;
            }
            return true;
          });

    const jobSuggestions = job.suggestions;
    const afterSuggestionGating =
      jobSuggestions === undefined
        ? afterSuppression
        : afterSuppression.map((c) => {
            if (!c.suggestion) return c;
            if (!jobSuggestions.enabled) {
              const { suggestion: _s, ...rest } = c;
              return rest as import('@review-agent/core').InlineComment;
            }
            if (c.category !== undefined && !jobSuggestions.categories.includes(c.category)) {
              const { suggestion: _s, ...rest } = c;
              return rest as import('@review-agent/core').InlineComment;
            }
            return c;
          });

    const scannedTexts: string[] = [result.summary];
    for (const c of afterSuggestionGating) {
      scannedTexts.push(c.body);
      if (c.suggestion) scannedTexts.push(c.suggestion);
    }
    const scannedText = scannedTexts.join('\n\n');
    const outputFindings = [...scanContent(scannedText)];
    const outputDecision = shouldAbortReview(outputFindings);
    if (outputDecision.abort) {
      throw new SecretLeakAbortedError(
        'output',
        outputFindings.length,
        uniqueRuleIds(outputFindings),
        outputDecision.reason ?? 'unknown',
      );
    }

    const summary =
      outputFindings.length === 0
        ? result.summary
        : applyRedactions(result.summary, outputFindings);
    const comments =
      outputFindings.length === 0
        ? afterSuggestionGating
        : afterSuggestionGating.map((c) => ({
            ...c,
            body: applyRedactions(c.body, outputFindings),
            ...(c.suggestion !== undefined
              ? { suggestion: applyRedactions(c.suggestion, outputFindings) }
              : {}),
          }));

    const providerToolCalls = result.toolCalls ?? 0;
    const toolCalls = Math.max(providerToolCalls, toolCallCounter);

    return {
      comments,
      summary,
      droppedDuplicates: dedup.droppedCount,
      droppedByFeedback: dedup.droppedByFeedback,
      droppedByRuleset: rulesetResult.dropped,
      droppedBySuppression,
      toolCalls,
    };
  };

  // -------------------------------------------------------------------
  // Determine which diff to review.
  //
  // Single-pass path: caps not exceeded → review the full filtered diff
  // as before (complete back-compat — same code path as pre-#158).
  //
  // Chunk path: caps exceeded AND largePr.enabled=true → sort files by
  // prioritization, split into chunks, review each chunk in sequence.
  // -------------------------------------------------------------------

  if (!capsExceeded) {
    // ----- Single-pass path (caps within bounds) -----
    const filtersApplied = filteredDiff !== parsedDiff;
    const effectiveDiffText = filtersApplied ? reassembleDiff(filteredDiff) : job.diffText;

    const diffFindings = [...scanContent(effectiveDiffText)];
    const diffDecision = shouldAbortReview(diffFindings);
    if (diffDecision.abort) {
      throw new SecretLeakAbortedError(
        'diff',
        diffFindings.length,
        uniqueRuleIds(diffFindings),
        diffDecision.reason ?? 'unknown',
      );
    }

    const effectiveChangedPaths = filtersApplied
      ? filteredDiff.files.map((f) => f.path)
      : (job.changedPaths ?? []);

    const autoFetch = await collectAutoFetchContext({
      changedPaths: effectiveChangedPaths,
      pathInstructions: job.pathInstructions,
      workspaceDir: job.workspaceDir,
      denyPatterns,
    });
    const wrappedMetadata = wrapUntrusted(job.prMetadata, {
      files: autoFetch.files,
      hitBudgetLimit: autoFetch.hitBudgetLimit,
      totalBytes: autoFetch.totalBytes,
    });
    const diffPayload = `${wrappedMetadata}\n\n${effectiveDiffText}`;

    // Graceful abort path (spec §7.3 #4).
    let result: ReviewOutput;
    try {
      result = await runSinglePass(diffPayload);
    } catch (err) {
      if (err instanceof SchemaValidationError) {
        const { reason, summary } = classifyAbort(err);
        const abortExclusionReport: ExclusionReport | undefined =
          pathFilterExclusions.length > 0
            ? { excludedFiles: pathFilterExclusions, capsApplied: [] }
            : undefined;
        return {
          comments: [],
          summary,
          costUsd: costState.totalCostUsd,
          tokensUsed: { input: 0, output: 0 },
          model: provider.model,
          provider: provider.name,
          droppedDuplicates: 0,
          droppedByRuleset: 0,
          toolCalls: toolCallCounter,
          reviewEvent: 'COMMENT',
          aborted: {
            reason,
            internalIssues: err.issues.map((i) => ({ path: i.path, message: i.message })),
          },
          ...(abortExclusionReport !== undefined ? { exclusionReport: abortExclusionReport } : {}),
          filesTotal: filteredDiff.files.length,
          filesReviewed: 0,
        };
      }
      throw err;
    }

    // Cross-chunk dedup seenFingerprints for single-pass: start from previousState.
    // Capture the pre-AI set so mergeExternalFindings can dedup against prior
    // reviews without also deduping against current-run AI findings (those are
    // handled via merge-policy conflict resolution, not blanket dedup).
    const previousFp = new Set<string>(job.previousState?.commentFingerprints ?? []);
    const seenFp = new Set<string>(previousFp);
    const filtered = applyPostLlmFilters(result, seenFp);

    // Merge external SARIF findings (back-compat: no-op when externalTools absent).
    const finalComments = mergeExternalFindings(
      job,
      filtered.comments,
      previousFp,
      rejectedFingerprints,
      suppressedFingerprints,
      (msg) => {
        /* v8 ignore next */ deps.logger?.(msg);
      },
    );

    const reviewEvent = computeReviewEvent(finalComments, job.requestChangesOn ?? 'critical');
    const exclusionReport: ExclusionReport | undefined =
      pathFilterExclusions.length > 0
        ? { excludedFiles: pathFilterExclusions, capsApplied: [] }
        : undefined;

    return {
      comments: finalComments,
      summary: filtered.summary,
      costUsd: costState.totalCostUsd,
      tokensUsed: { input: result.tokensUsed.input, output: result.tokensUsed.output },
      model: provider.model,
      provider: provider.name,
      droppedDuplicates: filtered.droppedDuplicates,
      droppedByFeedback: filtered.droppedByFeedback,
      droppedByRuleset: filtered.droppedByRuleset,
      ...(deps.suppressionLoader !== undefined
        ? { droppedBySuppression: filtered.droppedBySuppression }
        : {}),
      toolCalls: filtered.toolCalls,
      reviewEvent,
      ...(exclusionReport !== undefined ? { exclusionReport } : {}),
      filesTotal: filteredDiff.files.length,
      filesReviewed: filteredDiff.files.length,
    };
  }

  // ----- Chunk path: capsExceeded && largePr.enabled === true -----
  //
  // 1. Sort files by prioritization criteria.
  // 2. Split sorted files into chunks respecting per-chunk max_files/max_diff_lines.
  // 3. Review at most `max_chunks` chunks.
  // 4. Track cross-chunk dedup via a shared seenFingerprints Set.
  // 5. On CostExceededError mid-review: record remaining files as budget_exhausted.
  // 6. Files in chunks beyond max_chunks: record as max_chunks_exceeded.

  const pathInstructionGlobs = job.pathInstructions.map((pi) => pi.pattern);
  const sortedFiles = sortByPrioritization(
    filteredDiff.files,
    largePrConfig.prioritization,
    pathInstructionGlobs,
  );
  const allChunks = splitIntoChunks(
    sortedFiles,
    filteredDiff.preamble,
    job.maxFiles,
    job.maxDiffLines,
  );

  const maxChunks = largePrConfig.maxChunks;
  const chunksToReview = allChunks.slice(0, maxChunks);
  const chunksExceeded = allChunks.slice(maxChunks);

  // Files in chunks beyond max_chunks are recorded as max_chunks_exceeded.
  const maxChunksExclusionFiles: Array<ExcludedFile> = [];
  for (const chunk of chunksExceeded) {
    for (const f of chunk.files) {
      maxChunksExclusionFiles.push({ path: f.path, reason: 'max_chunks_exceeded' as const });
    }
  }

  // Cross-chunk dedup: accumulate fingerprints from previousState + each chunk.
  // `previousFp` is frozen at the pre-AI snapshot for use in mergeExternalFindings
  // (external findings matching prior-review fingerprints are dedup'd; those
  // matching current-run AI findings reach merge-policy conflict resolution).
  const previousFp = new Set<string>(job.previousState?.commentFingerprints ?? []);
  const seenFp = new Set<string>(previousFp);

  // Accumulated results across chunks.
  const allComments: Array<import('@review-agent/core').InlineComment> = [];
  const allSummaries: Array<string> = [];
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalDroppedDuplicates = 0;
  let totalDroppedByFeedback = 0;
  let totalDroppedByRuleset = 0;
  let totalDroppedBySuppression = 0;
  let totalToolCalls = 0;

  // Files not yet reviewed when cost cap fires.
  const budgetExhaustedFiles: Array<ExcludedFile> = [];
  let budgetExhausted = false;

  for (let chunkIdx = 0; chunkIdx < chunksToReview.length; chunkIdx++) {
    const chunk = chunksToReview[chunkIdx];
    if (!chunk) continue;

    if (budgetExhausted) {
      // Cost cap already fired in a previous chunk: all remaining files are budget_exhausted.
      for (const f of chunk.files) {
        budgetExhaustedFiles.push({ path: f.path, reason: 'budget_exhausted' as const });
      }
      continue;
    }

    let chunkPayload: {
      readonly diffPayload: string;
      readonly changedPaths: ReadonlyArray<string>;
    };
    try {
      chunkPayload = await buildDiffPayload(chunk);
    } catch (err) {
      if (err instanceof CostExceededError) {
        budgetExhausted = true;
        for (const f of chunk.files) {
          budgetExhaustedFiles.push({ path: f.path, reason: 'budget_exhausted' as const });
        }
        continue;
      }
      throw err;
    }

    let chunkResult: ReviewOutput;
    try {
      chunkResult = await runSinglePass(chunkPayload.diffPayload);
    } catch (err) {
      if (err instanceof CostExceededError) {
        budgetExhausted = true;
        for (const f of chunk.files) {
          budgetExhaustedFiles.push({ path: f.path, reason: 'budget_exhausted' as const });
        }
        continue;
      }
      if (err instanceof SchemaValidationError) {
        // Graceful abort for this chunk: skip the chunk, continue to next.
        // The abort is reflected in the summary but does not stop other chunks.
        const { summary: abortSummary } = classifyAbort(err);
        allSummaries.push(abortSummary);
        continue;
      }
      throw err;
    }

    const filtered = applyPostLlmFilters(chunkResult, seenFp);
    allComments.push(...filtered.comments);
    if (chunkResult.summary) allSummaries.push(chunkResult.summary);
    totalInputTokens += chunkResult.tokensUsed.input;
    totalOutputTokens += chunkResult.tokensUsed.output;
    totalDroppedDuplicates += filtered.droppedDuplicates;
    totalDroppedByFeedback += filtered.droppedByFeedback;
    totalDroppedByRuleset += filtered.droppedByRuleset;
    totalDroppedBySuppression += filtered.droppedBySuppression;
    totalToolCalls = Math.max(totalToolCalls, filtered.toolCalls);
  }

  // Build chunk summary: reviewed N files in M chunks, skipped files and reasons.
  const reviewedFilePaths = chunksToReview
    .flatMap((c) => (c ? c.files.map((f) => f.path) : []))
    .filter((p) => !budgetExhaustedFiles.some((ef) => ef.path === p));
  const skippedFilesMsg = buildChunkCoverageSummary(
    reviewedFilePaths.length,
    chunksToReview.length,
    [...maxChunksExclusionFiles, ...budgetExhaustedFiles, ...pathFilterExclusions],
  );

  // Merge summaries from all chunks.
  const mergedSummary =
    allSummaries.length > 0
      ? `${allSummaries.join('\n\n')}\n\n${skippedFilesMsg}`
      : skippedFilesMsg;

  const capsApplied: Array<'max_files' | 'max_diff_lines' | 'max_chunks' | 'budget_exhausted'> = [];
  if (exceedsFiles) capsApplied.push('max_files');
  if (exceedsLines) capsApplied.push('max_diff_lines');
  if (maxChunksExclusionFiles.length > 0) capsApplied.push('max_chunks');
  if (budgetExhaustedFiles.length > 0) capsApplied.push('budget_exhausted');

  const allExclusionFiles: Array<ExcludedFile> = [
    ...pathFilterExclusions,
    ...maxChunksExclusionFiles,
    ...budgetExhaustedFiles,
  ];
  const exclusionReport: ExclusionReport | undefined =
    allExclusionFiles.length > 0 || capsApplied.length > 0
      ? { excludedFiles: allExclusionFiles, capsApplied }
      : undefined;

  // Merge external SARIF findings after all chunks (back-compat: no-op when absent).
  const finalAllComments = mergeExternalFindings(
    job,
    allComments,
    previousFp,
    rejectedFingerprints,
    suppressedFingerprints,
    (msg) => {
      /* v8 ignore next */ deps.logger?.(msg);
    },
  );

  const reviewEvent = computeReviewEvent(finalAllComments, job.requestChangesOn ?? 'critical');

  return {
    comments: finalAllComments,
    summary: mergedSummary,
    costUsd: costState.totalCostUsd,
    tokensUsed: { input: totalInputTokens, output: totalOutputTokens },
    model: provider.model,
    provider: provider.name,
    droppedDuplicates: totalDroppedDuplicates,
    droppedByFeedback: totalDroppedByFeedback,
    droppedByRuleset: totalDroppedByRuleset,
    ...(deps.suppressionLoader !== undefined
      ? { droppedBySuppression: totalDroppedBySuppression }
      : {}),
    toolCalls: totalToolCalls,
    reviewEvent,
    ...(exclusionReport !== undefined ? { exclusionReport } : {}),
    filesTotal: filteredDiff.files.length,
    filesReviewed: reviewedFilePaths.length,
  };
}

/**
 * Wraps the agent loop with the v1.2 eval recorder (#83 Phase 2).
 * Measures wall-clock latency around the entire `runReview` flow
 * (including the gitleaks pre-scan, the LLM call, and dedup), and
 * fires `deps.evalRecorder` once with a `ReviewEvalEvent` built
 * from the final `RunnerResult`. Recording errors are routed
 * through `deps.onEvalRecordError` and never bubble out — by the
 * time we record, the review comments have already been posted (or
 * the abort summary already emitted), so a transient DB failure
 * must not retroactively crash the user-visible review.
 *
 * When `evalRecorder` is absent we keep the v1.1 behavior and just
 * forward the inner result so callers that don't run a DB worker
 * (local CLI, eval-only tests) pay zero overhead.
 */
export async function runReview(
  job: ReviewJob,
  provider: LlmProvider,
  deps: RunReviewDeps = {},
): Promise<RunnerResult> {
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const result = await runReviewInner(job, provider, deps);
  const latencyMs = Math.max(0, now() - startedAt);
  if (deps.evalRecorder && deps.evalContext) {
    const recorderOpts = {
      recorder: deps.evalRecorder,
      context: {
        installationId: deps.evalContext.installationId,
        jobId: job.jobId,
        repo: normalizeRepoKey(job.prRepo, deps.evalContext.installationId),
        prNumber: deps.evalContext.prNumber,
        headSha: deps.evalContext.headSha,
      },
      ...(deps.onEvalRecordError !== undefined ? { onRecordError: deps.onEvalRecordError } : {}),
    };
    await recordEvalEvent(recorderOpts, result, latencyMs);
  }
  return result;
}

/**
 * v1.2 #110: produce the `(installation_id, repo)` key used to look
 * up / write `review_history` and `review_eval_event` rows.
 *
 * GitHub PRs carry both `owner` and `repo`, so the key collapses to
 * `${owner}/${repo}`. CodeCommit PRs have no owner-segment (`owner`
 * is the empty string by adapter convention) — left unchanged that
 * produces `/repo`, which is indistinguishable across installations
 * sharing a repo name. Substituting the `installationId` (a numeric
 * AWS account id for CodeCommit) gives the same shape as the GitHub
 * form and isolates each tenant's rows from same-named repos in
 * other accounts.
 */
function normalizeRepoKey(
  prRepo: { readonly owner: string; readonly repo: string },
  installationId: bigint,
): string {
  const owner = prRepo.owner === '' ? String(installationId) : prRepo.owner;
  return `${owner}/${prRepo.repo}`;
}

function extractFingerprint(factText: string): string | null {
  // Parses `[fp:<hex>]` written by createFeedbackWriter. Returns null
  // for rows predating the writer so a partially-migrated table never
  // produces spurious dedup matches.
  const m = /^\[fp:([0-9a-f]+)\]/.exec(factText);
  return m?.[1] ?? null;
}

function uniqueRuleIds(findings: ReadonlyArray<GitleaksFinding>): ReadonlyArray<string> {
  const seen = new Set<string>();
  for (const f of findings) seen.add(f.ruleId);
  return [...seen];
}

function validateOutput(
  schema: ReturnType<typeof createReviewOutputSchema>,
  out: ReviewOutput,
): void {
  const parsed = schema.safeParse({
    summary: out.summary,
    comments: out.comments.map((c) => ({
      path: c.path,
      line: c.line,
      side: c.side,
      body: c.body,
      severity: c.severity,
      ...(c.category === undefined ? {} : { category: c.category }),
      ...(c.confidence === undefined ? {} : { confidence: c.confidence }),
      ...(c.ruleId === undefined ? {} : { ruleId: c.ruleId }),
      ...(c.suggestion === undefined ? {} : { suggestion: c.suggestion }),
    })),
  });
  if (!parsed.success) {
    throw new SchemaValidationError(
      'LLM output failed ReviewOutputSchema validation',
      parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
}

// `CONFIDENCES` is ordered most-confident → least-confident
// (`high`, `medium`, `low`). A comment passes the filter when its
// declared confidence is at or above the threshold — i.e. its index
// in CONFIDENCES is <= the threshold's index. Comments emitted
// without a confidence field are treated as `'high'` (the strongest
// signal) so legacy reviews are not silently demoted by tightening
// `min_confidence`.
function meetsConfidence(commentConfidence: Confidence | undefined, floor: Confidence): boolean {
  const declared = commentConfidence ?? 'high';
  return CONFIDENCES.indexOf(declared) <= CONFIDENCES.indexOf(floor);
}

async function compose(
  middlewares: ReadonlyArray<Middleware>,
  ctx: MiddlewareCtx,
  terminal: () => Promise<ReviewOutput>,
): Promise<ReviewOutput> {
  let next = terminal;
  for (let i = middlewares.length - 1; i >= 0; i--) {
    const mw = middlewares[i];
    if (!mw) continue;
    const downstream = next;
    next = () => mw(ctx, downstream);
  }
  return next();
}
