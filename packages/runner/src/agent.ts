import {
  type Category,
  CONFIDENCES,
  type Confidence,
  computeReviewEvent,
  createReviewOutputSchema,
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
  parseDiffByFile,
  reassembleDiff,
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
import { createAiSdkToolset, MAX_TOOL_CALLS, type ToolName } from './tools.js';
import type {
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
  };
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
  if (filteredDiff.files.length > job.maxFiles) {
    return buildCapSkipResult(
      provider,
      'max_files_exceeded',
      maxFilesSkipSummary(filteredDiff.files.length, job.maxFiles),
    );
  }
  const diffLineCount = countDiffLines(filteredDiff);
  if (diffLineCount > job.maxDiffLines) {
    return buildCapSkipResult(
      provider,
      'max_diff_lines_exceeded',
      maxDiffLinesSkipSummary(diffLineCount, job.maxDiffLines),
    );
  }
  const filtersApplied = filteredDiff !== parsedDiff;
  const effectiveDiffText = filtersApplied ? reassembleDiff(filteredDiff) : job.diffText;
  const effectiveChangedPaths = filtersApplied
    ? filteredDiff.files.map((f) => f.path)
    : (job.changedPaths ?? []);

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

  // Compile operator-supplied glob deny paths once per review.
  // Built-in `DENY_PATTERNS` are unioned in by the dispatcher
  // (spec §7.4 "extend, not relax"); we only need to forward the
  // operator-extended layer here. The YAML schema rejects invalid
  // entries up front via `z.string().min(1).refine(isValidGlob)`
  // on `PrivacySchema.deny_paths`, so a `globToRegExp` throw here
  // would indicate a programmer error upstream (e.g. a caller
  // bypassing the schema) and should fail loudly, not be swallowed.
  const denyPatterns: ReadonlyArray<RegExp> = job.privacy.denyPaths.map((g) => globToRegExp(g));

  // Counter shared with the AI-SDK tool wrappers so we can attribute
  // tool calls to the agent step that initiated them. The provider
  // also reports `toolCalls` derived from the AI-SDK step results;
  // we take the larger of the two so refused-before-dispatch calls
  // still show up in the cost-guard accounting.
  let toolCallCounter = 0;
  const tools = createAiSdkToolset({
    workspace: job.workspaceDir,
    denyPatterns,
    onCall: (_name: ToolName) => {
      toolCallCounter += 1;
    },
  });

  // Auto-fetch related files (per path_instructions[*].autoFetch)
  // before the LLM call so the model has the test / type / sibling
  // context inline without spending a tool-call round-trip on each.
  // No-op when `workspaceDir` is empty (Server mode with
  // `workspace_strategy: 'none'`) or no instruction has autoFetch
  // enabled. Bounded by `DEFAULT_AUTO_FETCH_BUDGET` (5 files /
  // 50 KB each / 250 KB total).
  //
  // The fetched files MUST be passed into `wrapUntrusted` as a
  // child element of `<untrusted>` rather than appended after the
  // envelope — auto-fetched bytes are author-controlled (a prior
  // PR could have planted a prompt-injection prelude in the test
  // companion) and the system prompt's "treat <untrusted> content
  // as data" rule must cover them. Reviewer flagged this on the
  // original #70 commit as I-1; the fix moves the rendering into
  // the wrapper.
  const autoFetch = await collectAutoFetchContext({
    changedPaths: effectiveChangedPaths,
    pathInstructions: job.pathInstructions,
    workspaceDir: job.workspaceDir,
    // Same compiled `denyPatterns` instance the dispatcher uses, so
    // auto-fetched companion files honor `privacy.deny_paths`. Built-in
    // `DENY_PATTERNS` are unioned in by `createTools` regardless;
    // this just closes the operator-extended layer (spec §7.4).
    denyPatterns,
  });
  const wrappedMetadata = wrapUntrusted(job.prMetadata, {
    files: autoFetch.files,
    hitBudgetLimit: autoFetch.hitBudgetLimit,
    totalBytes: autoFetch.totalBytes,
  });
  const diffPayload = `${wrappedMetadata}\n\n${effectiveDiffText}`;

  const baseInput: ReviewInput = {
    systemPrompt,
    diffText: diffPayload,
    prMetadata: job.prMetadata,
    fileReader,
    language: job.language,
    tools,
    maxToolCalls: MAX_TOOL_CALLS,
  };

  const costState: CostState = { totalCostUsd: 0 };
  const middlewares: ReadonlyArray<Middleware> = [
    createInjectionGuard(),
    createCostGuard({ state: costState }),
  ];

  // Build the per-job factory schema once and reuse for both the
  // first attempt and the retry. `prRepo` / `privacy.allowedUrlPrefixes`
  // are wired by T3 through ReviewJob; no env lookup happens here.
  const outputSchema = createReviewOutputSchema({
    allowedUrlPrefixes: job.privacy.allowedUrlPrefixes,
    prRepo: job.prRepo,
  });

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

  // Graceful abort path (spec §7.3 #4): when the second attempt also
  // fails schema validation we DO NOT throw — surfacing the abort as
  // an exception would crash the Action / CLI and leave the PR
  // without any signal. Instead we collapse to an empty-comments
  // RunnerResult whose `summary` is the operator-facing notice and
  // whose `aborted.reason` discriminates URL allowlist vs other
  // schema failures. Cost accounting is preserved (the cost-guard
  // middleware has already accumulated both attempts into
  // `costState`).
  let result: ReviewOutput;
  try {
    result = await compose(middlewares, ctx, main);
  } catch (err) {
    if (err instanceof SchemaValidationError) {
      const { reason, summary } = classifyAbort(err);
      return {
        comments: [],
        // The summary is the ONLY string that will reach a public
        // surface (PR comment via vcs.postReview). It's a generic
        // notice with no URL substring — see `classifyAbort` and the
        // `*_ABORT_SUMMARY` constants. The raw Zod issues (which
        // contain the rejected URL, potentially with attacker-
        // injected secrets in the query string) go on
        // `aborted.internalIssues` strictly for audit / telemetry.
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
      };
    }
    throw err;
  }
  const dedup = dedupComments(result, {
    previousState: job.previousState,
    rejectedFingerprints,
  });

  // Apply the operator-configured confidence floor *after* dedup so the
  // fingerprint set on the kept list is still well-formed; comments
  // dropped here do not contribute to the next review's state (i.e. we
  // do not "remember" we suppressed them, by design — operator wants
  // them silent, not memoized).
  const minConfidence = job.minConfidence ?? 'low';
  const afterConfidence = dedup.kept.filter((c) => meetsConfidence(c.confidence, minConfidence));

  // Apply the operator-configured ruleset filter *after* the confidence
  // filter. The ruleset is the §10.1 category/severity enforcement layer:
  //   1. Findings with no `category` get DEFAULT_RULESET_CATEGORY ('bug').
  //   2. Findings in a disabled category are suppressed.
  //   3. Findings below the category's `min_severity` floor are suppressed.
  const rulesetResult = applyRulesetFilter(afterConfidence, job.ruleset);
  const filteredKept = rulesetResult.kept;

  const scannedText = [result.summary, ...filteredKept.map((c) => c.body)].join('\n\n');
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
    outputFindings.length === 0 ? result.summary : applyRedactions(result.summary, outputFindings);
  const comments =
    outputFindings.length === 0
      ? filteredKept
      : filteredKept.map((c) => ({ ...c, body: applyRedactions(c.body, outputFindings) }));

  // Take the larger of the two sources so refused-before-dispatch
  // calls (counted locally) AND retry-path calls (counted on the
  // SDK side only for the retry attempt) both show up in the
  // cost-guard accounting. On the schema-retry path, `result` is
  // the retried attempt — its `steps` cover only that attempt,
  // while `toolCallCounter` accumulates across both. A ternary
  // ("prefer provider when >0") collapses to the retry-only count
  // and silently undercounts the main attempt's tool use; Math.max
  // preserves both. SDK-recorded calls our `onCall` hook missed
  // (arg-parse failures where `execute` never fires) are likewise
  // covered when the provider count exceeds the local one.
  const providerToolCalls = result.toolCalls ?? 0;
  const toolCalls = Math.max(providerToolCalls, toolCallCounter);

  // Map severity → GitHub review event so a critical finding can
  // drive `REQUEST_CHANGES` (and operators can wire that into a
  // branch-protection rule). Computed against the *kept* comments
  // (post-dedup, post-confidence-filter, post-redaction) so we don't
  // request changes on findings that aren't actually being posted.
  const reviewEvent = computeReviewEvent(comments, job.requestChangesOn ?? 'critical');

  return {
    comments,
    summary,
    costUsd: costState.totalCostUsd,
    tokensUsed: { input: result.tokensUsed.input, output: result.tokensUsed.output },
    model: provider.model,
    provider: provider.name,
    droppedDuplicates: dedup.droppedCount,
    droppedByFeedback: dedup.droppedByFeedback,
    droppedByRuleset: rulesetResult.dropped,
    toolCalls,
    reviewEvent,
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
