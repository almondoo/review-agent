import { ReviewOutputSchema, SchemaValidationError } from '@review-agent/core';
import type { LlmProvider, ReviewInput, ReviewOutput } from '@review-agent/llm';
import {
  type CostState,
  createCostGuard,
  createInjectionGuard,
  dedupComments,
} from './middleware/index.js';
import { composeSystemPrompt } from './prompts/system-prompt.js';
import { wrapUntrusted } from './prompts/untrusted.js';
import type { Middleware, MiddlewareCtx, ReviewJob, RunnerResult, RunReviewDeps } from './types.js';

const RETRY_PROMPT_SUFFIX =
  '\n\nIMPORTANT: your previous response failed schema validation. Produce strictly valid output that matches the configured schema.';

export async function runReview(
  job: ReviewJob,
  provider: LlmProvider,
  deps: RunReviewDeps = {},
): Promise<RunnerResult> {
  const systemPrompt = composeSystemPrompt({
    profile: job.profile,
    skills: job.skills,
    pathInstructions: job.pathInstructions,
    language: job.language,
  });
  const fileReader = deps.fileReader ?? (async () => '');

  const baseInput: ReviewInput = {
    systemPrompt,
    diffText: `${wrapUntrusted(job.prMetadata)}\n\n${job.diffText}`,
    prMetadata: job.prMetadata,
    fileReader,
    language: job.language,
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

  return {
    comments: dedup.kept,
    summary: result.summary,
    costUsd: costState.totalCostUsd,
    tokensUsed: { input: result.tokensUsed.input, output: result.tokensUsed.output },
    model: provider.model,
    provider: provider.name,
    droppedDuplicates: dedup.droppedCount,
  };
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
