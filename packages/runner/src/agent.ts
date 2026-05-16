import {
  ReviewOutputSchema,
  SchemaValidationError,
  SecretLeakAbortedError,
} from '@review-agent/core';
import type { LlmProvider, ReviewInput, ReviewOutput } from '@review-agent/llm';
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
import type { Middleware, MiddlewareCtx, ReviewJob, RunnerResult, RunReviewDeps } from './types.js';

const RETRY_PROMPT_SUFFIX =
  '\n\nIMPORTANT: your previous response failed schema validation. Produce strictly valid output that matches the configured schema.';

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

  const baseInput: ReviewInput = {
    systemPrompt,
    diffText: `${wrapUntrusted(job.prMetadata)}\n\n${job.diffText}`,
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

  const ctx: MiddlewareCtx = { job, input: baseInput, provider };
  const main = async (): Promise<ReviewOutput> => {
    try {
      const out = await provider.generateReview(ctx.input);
      validateOutput(out);
      return out;
    } catch (err) {
      if (!(err instanceof SchemaValidationError)) throw err;
      const retried = await provider.generateReview({
        ...ctx.input,
        systemPrompt: ctx.input.systemPrompt + RETRY_PROMPT_SUFFIX,
      });
      validateOutput(retried);
      return retried;
    }
  };

  const result = await compose(middlewares, ctx, main);
  const dedup = dedupComments(result, { previousState: job.previousState });

  const scannedText = [result.summary, ...dedup.kept.map((c) => c.body)].join('\n\n');
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
      ? dedup.kept
      : dedup.kept.map((c) => ({ ...c, body: applyRedactions(c.body, outputFindings) }));

  // Prefer the provider-reported tool-call count (sourced from the
  // AI-SDK step results) when it's non-zero, otherwise fall back to
  // the local counter. They typically agree; the divergence path
  // covers test doubles that don't populate steps, and tool calls
  // refused before dispatch (which our counter still increments).
  const providerToolCalls = result.toolCalls ?? 0;
  const toolCalls = providerToolCalls > 0 ? providerToolCalls : toolCallCounter;

  return {
    comments,
    summary,
    costUsd: costState.totalCostUsd,
    tokensUsed: { input: result.tokensUsed.input, output: result.tokensUsed.output },
    model: provider.model,
    provider: provider.name,
    droppedDuplicates: dedup.droppedCount,
    toolCalls,
  };
}

function uniqueRuleIds(findings: ReadonlyArray<GitleaksFinding>): ReadonlyArray<string> {
  const seen = new Set<string>();
  for (const f of findings) seen.add(f.ruleId);
  return [...seen];
}

function validateOutput(out: ReviewOutput): void {
  const parsed = ReviewOutputSchema.safeParse({
    summary: out.summary,
    comments: out.comments.map((c) => ({
      path: c.path,
      line: c.line,
      side: c.side,
      body: c.body,
      severity: c.severity,
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
