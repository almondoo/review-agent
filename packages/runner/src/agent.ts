import {
  CONFIDENCES,
  type Confidence,
  computeReviewEvent,
  createReviewOutputSchema,
  SchemaValidationError,
  SecretLeakAbortedError,
  URL_ALLOWLIST_ISSUE_PREFIX,
} from '@review-agent/core';
import type { LlmProvider, ReviewInput, ReviewOutput } from '@review-agent/llm';
import { collectAutoFetchContext } from './auto-fetch.js';
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
} from './middleware/index.js';
import { composeSystemPrompt } from './prompts/system-prompt.js';
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

export async function runReview(
  job: ReviewJob,
  provider: LlmProvider,
  deps: RunReviewDeps = {},
): Promise<RunnerResult> {
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
  const systemPrompt = composeSystemPrompt(promptOptions);
  const fileReader = deps.fileReader ?? (async () => '');
  const scanContent = deps.scanContent ?? quickScanContent;

  const diffFindings = [...scanContent(job.diffText)];
  const diffDecision = shouldAbortReview(diffFindings);
  if (diffDecision.abort) {
    throw new SecretLeakAbortedError(
      'diff',
      diffFindings.length,
      uniqueRuleIds(diffFindings),
      diffDecision.reason ?? 'unknown',
    );
  }

  // Counter shared with the AI-SDK tool wrappers so we can attribute
  // tool calls to the agent step that initiated them. The provider
  // also reports `toolCalls` derived from the AI-SDK step results;
  // we take the larger of the two so refused-before-dispatch calls
  // still show up in the cost-guard accounting.
  let toolCallCounter = 0;
  const tools = createAiSdkToolset({
    workspace: job.workspaceDir,
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
    changedPaths: job.changedPaths ?? [],
    pathInstructions: job.pathInstructions,
    workspaceDir: job.workspaceDir,
  });
  const wrappedMetadata = wrapUntrusted(job.prMetadata, {
    files: autoFetch.files,
    hitBudgetLimit: autoFetch.hitBudgetLimit,
    totalBytes: autoFetch.totalBytes,
  });
  const diffPayload = `${wrappedMetadata}\n\n${job.diffText}`;

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
  const dedup = dedupComments(result, { previousState: job.previousState });

  // Apply the operator-configured confidence floor *after* dedup so the
  // fingerprint set on the kept list is still well-formed; comments
  // dropped here do not contribute to the next review's state (i.e. we
  // do not "remember" we suppressed them, by design — operator wants
  // them silent, not memoized).
  const minConfidence = job.minConfidence ?? 'low';
  const filteredKept = dedup.kept.filter((c) => meetsConfidence(c.confidence, minConfidence));

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
    toolCalls,
    reviewEvent,
  };
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
