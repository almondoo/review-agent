import { readFile } from 'node:fs/promises';
import {
  type Config,
  defaultConfig,
  KNOWN_REVIEW_BOT_LOGINS,
  loadConfigFromYaml,
  mergeWithEnv,
} from '@review-agent/config';
import {
  computeDiffStrategy as defaultComputeDiffStrategy,
  type PR,
  type PRRef,
  type ReviewState,
  type VCS,
} from '@review-agent/core';
import { createAnthropicProvider, type LlmProvider } from '@review-agent/llm';
import { createGithubVCS } from '@review-agent/platform-github';
import {
  buildReviewState,
  decideCoordination,
  loadSkills,
  type RunnerResult,
  renderDeferralSummary,
  renderSkillsBlock,
  runReview,
} from '@review-agent/runner';
import type { ActionInputs } from './inputs.js';
import { withRetry } from './retry.js';

export type RunActionDeps = {
  readonly readFile?: (p: string, enc: 'utf8') => Promise<string>;
  readonly createVCS?: (token: string) => VCS;
  readonly createProvider?: (apiKey: string, config: Config) => LlmProvider;
  readonly env?: NodeJS.ProcessEnv;
  /**
   * Injection seam for `computeDiffStrategy`. Defaults to the
   * production implementation in `@review-agent/core`, which shells
   * out to `git merge-base`. Tests inject a deterministic fake.
   */
  readonly computeDiffStrategy?: typeof defaultComputeDiffStrategy;
  /**
   * Sink for the 'rebase detected' / 'incremental review' log lines.
   * Production wiring defaults to `console.info`; tests inject a spy.
   * Kept as a `(msg, meta) => void` rather than a full pino logger so
   * the action package stays dependency-free for now.
   */
  readonly logger?: (msg: string, meta?: Record<string, unknown>) => void;
  /**
   * Injectable sleep for retry backoff. Production defaults to
   * setTimeout in `retry.ts`; tests inject a no-op so they don't
   * pay real wall-clock delays.
   */
  readonly sleep?: (ms: number) => Promise<void>;
};

export type ActionContext = {
  readonly ref: PRRef;
};

export type ActionResult = {
  readonly skipped: boolean;
  readonly skipReason: string | null;
  readonly postedComments: number;
  readonly costUsd: number;
};

const NO_RUN: ActionResult = {
  skipped: true,
  skipReason: null,
  postedComments: 0,
  costUsd: 0,
};

export async function runAction(
  inputs: ActionInputs,
  ctx: ActionContext,
  deps: RunActionDeps = {},
): Promise<ActionResult> {
  const readFn = deps.readFile ?? ((p, enc) => readFile(p, enc as BufferEncoding).then(String));
  const env = deps.env ?? process.env;

  const config = await loadConfigOrDefault(inputs.configPath, readFn, env);

  const vcs = (deps.createVCS ?? ((t) => createGithubVCS({ token: t })))(inputs.githubToken);
  const pr = await vcs.getPR(ctx.ref);

  const skipReason = decideSkip(pr, config);
  if (skipReason) return { ...NO_RUN, skipReason };

  const coordination = await decideCoordinationForRun(vcs, ctx.ref, config);
  if (coordination.action === 'defer') {
    await vcs.postSummary(ctx.ref, renderDeferralSummary(coordination.bot));
    return { ...NO_RUN, skipReason: `Deferred to '${coordination.bot}' (coordination policy)` };
  }

  const provider = (deps.createProvider ?? ((key, cfg) => buildAnthropicProvider(key, cfg)))(
    inputs.anthropicApiKey ?? '',
    config,
  );

  const previousState = await vcs.getStateComment(ctx.ref);
  const workspaceDir = process.cwd();
  const log = deps.logger ?? defaultLogger;
  const computeStrategy = deps.computeDiffStrategy ?? defaultComputeDiffStrategy;
  const strategy = await computeStrategy(workspaceDir, previousState, {
    baseSha: pr.baseSha,
    headSha: pr.headSha,
  });
  const incremental = strategy !== 'full';
  // 'rebase detected' covers any case where we had prior review state
  // but couldn't safely reuse it — merge-base shift, lastReviewedSha
  // unreachable, or git-side error. The Action prints to stdout (will
  // surface in the GitHub UI's run log); production audit_log entries
  // for the same event are emitted from the runner in #65.
  if (previousState && strategy === 'full') {
    log('rebase detected', {
      previousSha: previousState.lastReviewedSha,
      headSha: pr.headSha,
      baseSha: pr.baseSha,
    });
  } else if (incremental) {
    log('incremental review', {
      sinceSha: strategy.since,
      headSha: pr.headSha,
    });
  }

  const diff = incremental
    ? await vcs.getDiff(ctx.ref, { sinceSha: strategy.since })
    : await vcs.getDiff(ctx.ref);
  const diffText = diff.files.map((f) => `--- ${f.path}\n${f.patch ?? ''}`).join('\n');

  const skills = await loadSkills(config.skills, '.', { readFile: readFn });
  const skillBlock = renderSkillsBlock(skills, {
    changedPaths: diff.files.map((f) => f.path),
  });

  const reviewJob: Parameters<typeof runReview>[0] = {
    jobId: `${ctx.ref.owner}/${ctx.ref.repo}#${ctx.ref.number}`,
    workspaceDir,
    diffText,
    prMetadata: {
      title: pr.title,
      body: pr.body,
      author: pr.author,
      baseRef: pr.baseRef,
      labels: pr.labels,
      commitMessages: pr.commitMessages,
    },
    previousState,
    profile: config.profile,
    pathInstructions: config.reviews.path_instructions.map((p) => ({
      pattern: p.path,
      text: p.instructions,
    })),
    skills: skillBlock ? [skillBlock] : [],
    language: config.language,
    costCapUsd: inputs.costCapUsd,
    minConfidence: config.reviews.min_confidence,
    requestChangesOn: config.reviews.request_changes_on,
  };
  if (incremental) {
    (reviewJob as { incrementalContext?: boolean }).incrementalContext = true;
    (reviewJob as { incrementalSinceSha?: string }).incrementalSinceSha = strategy.since;
  }

  const result = await runReview(reviewJob, provider);

  await postOrUpdate(vcs, ctx.ref, pr, result, previousState, {
    stateWriteRetries: inputs.stateWriteRetries,
    log,
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
  });

  return {
    skipped: false,
    skipReason: null,
    postedComments: result.comments.length,
    costUsd: result.costUsd,
  };
}

function decideSkip(pr: PR, config: Config): string | null {
  if (pr.draft && !config.reviews.auto_review.drafts) {
    return 'PR is in draft state and config.reviews.auto_review.drafts=false';
  }
  if (config.reviews.ignore_authors.includes(pr.author)) {
    return `Author '${pr.author}' is in ignore_authors`;
  }
  return null;
}

// Lists existing PR comments and runs the coordination decision so
// the action defers to another review bot when configured. The VCS
// adapter's `getExistingComments` returns inline review comments
// only — bots that post solely a summary PR comment (no inline
// comments at all) are NOT detected here even when added to
// `coordination.other_bots_logins`. Extending the VCS adapter to
// also list `issues.listComments` authors is tracked as a v1.x
// follow-up. See `docs/configuration/coordination.md`.
async function decideCoordinationForRun(
  vcs: VCS,
  ref: PRRef,
  config: Config,
): Promise<ReturnType<typeof decideCoordination>> {
  if (config.coordination.other_bots === 'ignore') {
    return { action: 'proceed' };
  }
  const existing = await vcs.getExistingComments(ref);
  return decideCoordination({
    mode: config.coordination.other_bots,
    botLogins: [...KNOWN_REVIEW_BOT_LOGINS, ...config.coordination.other_bots_logins],
    existingCommentAuthors: existing.map((c) => c.author),
  });
}

async function loadConfigOrDefault(
  configPath: string,
  readFn: (p: string, enc: 'utf8') => Promise<string>,
  env: NodeJS.ProcessEnv,
): Promise<Config> {
  let yamlText: string | null = null;
  try {
    yamlText = await readFn(configPath, 'utf8');
  } catch {
    yamlText = null;
  }
  const base = yamlText === null ? defaultConfig() : loadConfigFromYaml(yamlText);
  const overrides: {
    REVIEW_AGENT_LANGUAGE?: string;
    REVIEW_AGENT_PROVIDER?: string;
    REVIEW_AGENT_MODEL?: string;
    REVIEW_AGENT_MAX_USD_PER_PR?: string;
  } = {};
  if (env.REVIEW_AGENT_LANGUAGE) overrides.REVIEW_AGENT_LANGUAGE = env.REVIEW_AGENT_LANGUAGE;
  if (env.REVIEW_AGENT_PROVIDER) overrides.REVIEW_AGENT_PROVIDER = env.REVIEW_AGENT_PROVIDER;
  if (env.REVIEW_AGENT_MODEL) overrides.REVIEW_AGENT_MODEL = env.REVIEW_AGENT_MODEL;
  if (env.REVIEW_AGENT_MAX_USD_PER_PR)
    overrides.REVIEW_AGENT_MAX_USD_PER_PR = env.REVIEW_AGENT_MAX_USD_PER_PR;
  return mergeWithEnv(base, overrides);
}

function defaultLogger(msg: string, meta?: Record<string, unknown>): void {
  // GitHub Action consumers surface stdout to the run log; the
  // 'rebase detected' / 'incremental review' lines are the only
  // operator-visible signal of which diff path the action took, so
  // a console.info is the simplest sink that still works with
  // GitHub Actions' annotation parser. Server-mode wiring will
  // route through OTel + audit_log in #65 / #63.
  if (meta && Object.keys(meta).length > 0) {
    // biome-ignore lint/suspicious/noConsole: structured operator-visible log line
    console.info(`[review-agent] ${msg}`, meta);
  } else {
    // biome-ignore lint/suspicious/noConsole: structured operator-visible log line
    console.info(`[review-agent] ${msg}`);
  }
}

function buildAnthropicProvider(apiKey: string, config: Config): LlmProvider {
  const providerConfig: {
    type: 'anthropic';
    model: string;
    apiKey?: string;
    anthropicCacheControl: boolean;
  } = {
    type: 'anthropic',
    model: config.provider?.model ?? 'claude-sonnet-4-6',
    anthropicCacheControl: config.provider?.anthropic_cache_control ?? true,
  };
  if (apiKey) providerConfig.apiKey = apiKey;
  return createAnthropicProvider(providerConfig);
}

async function postOrUpdate(
  vcs: VCS,
  ref: PRRef,
  pr: PR,
  result: RunnerResult,
  previousState: ReviewState | null,
  opts: {
    readonly stateWriteRetries: number;
    readonly log: (msg: string, meta?: Record<string, unknown>) => void;
    readonly sleep?: (ms: number) => Promise<void>;
  },
): Promise<void> {
  const state = buildReviewState({
    previousState,
    comments: result.comments,
    headSha: pr.headSha,
    baseSha: pr.baseSha,
    modelUsed: result.model,
    tokensUsed: result.tokensUsed.input + result.tokensUsed.output,
    costUsd: result.costUsd,
  });

  // postReview ("inline review + summary") is wrapped in the same retry
  // budget as the state-comment write. On exhaustion, the action fails
  // — operators want to know that GitHub never received the review,
  // not silently pass with zero comments posted. The retry helper
  // takes a total-attempt count; `stateWriteRetries` is the number of
  // retries on top of the first attempt, so total = retries + 1.
  const totalAttempts = opts.stateWriteRetries + 1;
  await withRetry(
    () =>
      vcs.postReview(ref, {
        comments: result.comments,
        summary: result.summary,
        state,
        event: result.reviewEvent,
      }),
    {
      attempts: totalAttempts,
      label: 'vcs.postReview',
      logger: opts.log,
      ...(opts.sleep ? { sleep: opts.sleep } : {}),
    },
  );

  // The state comment is the only record of "what we already reviewed"
  // in Action mode. Wrap in retry; on exhaustion throw with the
  // operator-facing message so `core.setFailed` surfaces it in the
  // run log. Note that even `stateWriteRetries: 0` means one attempt
  // (no retries) — the state write always runs at least once.
  try {
    await withRetry(() => vcs.upsertStateComment(ref, state), {
      attempts: totalAttempts,
      label: 'vcs.upsertStateComment',
      logger: opts.log,
      ...(opts.sleep ? { sleep: opts.sleep } : {}),
    });
  } catch (err) {
    const message = `State comment write failed after ${opts.stateWriteRetries} retries; next review will be a full re-review.`;
    opts.log(message, { error: err instanceof Error ? err.message : String(err) });
    throw new Error(message);
  }
}
