import { readFile } from 'node:fs/promises';
import { type Config, KNOWN_REVIEW_BOT_LOGINS, resolveEffectiveConfig } from '@review-agent/config';
import {
  type Diff,
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
import {
  buildNotificationChannels,
  createNotificationDispatcher,
  type NotificationDispatcher,
} from '@review-agent/server/notification';
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
  /**
   * #144 Phase B: injectable notification dispatcher for tests.
   * Production callers leave this unset — the dispatcher is built from
   * `config.notifications` + env vars inside `runAction`. Tests inject a
   * mock to verify event dispatch without real channel side-effects.
   */
  readonly notificationDispatcher?: NotificationDispatcher;
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

  // #144 Phase B: build the notification dispatcher from config + env.
  // Zero channels → dispatcher is a no-op (all dispatch calls return immediately).
  // Tests may inject deps.notificationDispatcher directly.
  const notifier: NotificationDispatcher =
    deps.notificationDispatcher ??
    createNotificationDispatcher({
      channels: buildNotificationChannels(config.notifications, {
        REVIEW_AGENT_SLACK_WEBHOOK_URL: env.REVIEW_AGENT_SLACK_WEBHOOK_URL,
        REVIEW_AGENT_SMTP_PASSWORD: env.REVIEW_AGENT_SMTP_PASSWORD,
      }),
      config: config.notifications,
    });

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

  // Load external SARIF tool contents. Each configured tool's sarif_path is read
  // from the Action workspace (same cwd as the diff). Missing/unreadable files
  // are warned and skipped — the review continues without that tool's findings.
  const externalTools = await loadExternalToolContents(config.external_tools.tools, readFn, log);

  const jobId = `${ctx.ref.owner}/${ctx.ref.repo}#${ctx.ref.number}`;
  const notificationRepo = `${ctx.ref.owner}/${ctx.ref.repo}`;
  const reviewJob: Parameters<typeof runReview>[0] = {
    jobId,
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
    changedPaths: diff.files.map((f) => f.path),
    pathInstructions: config.reviews.path_instructions.map((p) => ({
      pattern: p.path,
      text: p.instructions,
      ...(p.auto_fetch ? { autoFetch: p.auto_fetch } : {}),
    })),
    skills: skillBlock ? [skillBlock] : [],
    language: config.language,
    costCapUsd: inputs.costCapUsd,
    minConfidence: config.reviews.min_confidence,
    requestChangesOn: config.reviews.request_changes_on,
    ruleset: config.ruleset,
    pathFilters: config.reviews.path_filters,
    maxFiles: config.reviews.max_files,
    maxDiffLines: config.reviews.max_diff_lines,
    maxSteps: config.reviews.max_steps,
    suggestions: config.suggestions,
    largePr: {
      enabled: config.large_pr.enabled,
      maxChunks: config.large_pr.max_chunks,
      prioritization: config.large_pr.prioritization,
    },
    privacy: {
      allowedUrlPrefixes: config.privacy.allowed_url_prefixes,
      denyPaths: config.privacy.deny_paths,
      redactPatterns: config.privacy.redact_patterns,
    },
    prRepo: {
      host: inferGithubHost(env),
      owner: ctx.ref.owner,
      repo: ctx.ref.repo,
    },
    ...(externalTools.length > 0 ? { externalTools } : {}),
    summary: {
      walkthrough: config.summary.walkthrough,
      changeImpact: config.summary.change_impact,
      dependencyView: config.summary.dependency_view,
    },
  };
  if (incremental) {
    (reviewJob as { incrementalContext?: boolean }).incrementalContext = true;
    (reviewJob as { incrementalSinceSha?: string }).incrementalSinceSha = strategy.since;
  }

  // #144 Phase B: budget.overrun — fired by cost-guard when cumulative cost
  // crosses cost.budget_alert_usd. Fail-open: dispatch errors are caught so
  // a notification failure never aborts the review.
  const onThresholdCrossed = (e: {
    readonly threshold: 'fallback' | 'abort' | 'kill' | 'daily_cap' | 'budget_alert';
    readonly cumulativeUsd: number;
    readonly capUsd: number;
  }): void => {
    if (e.threshold === 'budget_alert') {
      const event = {
        type: 'budget.overrun' as const,
        repo: notificationRepo,
        installationId: '0',
        jobId,
        timestamp: new Date().toISOString(),
        prNumber: ctx.ref.number,
        summary: `Budget alert: cumulative cost $${e.cumulativeUsd.toFixed(4)} exceeded alert threshold $${e.capUsd.toFixed(4)}`,
      };
      notifier.dispatch(event).catch(() => {
        // fail-open: notification failure must not affect review result
      });
    }
  };

  let result: RunnerResult;
  try {
    result = await runReview(reviewJob, provider, {
      logger: log,
      onThresholdCrossed,
      ...(config.cost.budget_alert_usd !== undefined
        ? { budgetAlertUsd: config.cost.budget_alert_usd }
        : {}),
    });
  } catch (err) {
    // #144 Phase B: job.failed — runReview threw a permanent error.
    // Dispatch the notification fail-open (swallow dispatch errors), then re-throw.
    // Note: job.failed here is an interim signal based on runReview throw.
    // Accurate DLQ-based permanent-failure detection is tracked in issue #138.
    const failEvent = {
      type: 'job.failed' as const,
      repo: notificationRepo,
      installationId: '0',
      jobId,
      timestamp: new Date().toISOString(),
      prNumber: ctx.ref.number,
      summary: `Job failed: ${err instanceof Error ? err.message : String(err)}`,
    };
    notifier.dispatch(failEvent).catch(() => {
      // fail-open: notification failure must not shadow the original error
    });
    throw err;
  }

  // #144 Phase B: review.completed — successful review.
  // Dispatch only when config.notifications.events.review_completed is enabled.
  // The dispatcher gate handles the enable check, so we always call dispatch
  // and let the dispatcher no-op when the event type is disabled.
  const completeEvent = {
    type: 'review.completed' as const,
    repo: notificationRepo,
    installationId: '0',
    jobId,
    timestamp: new Date().toISOString(),
    prNumber: ctx.ref.number,
    summary: `Review completed: ${result.comments.length} finding${result.comments.length !== 1 ? 's' : ''}`,
  };
  notifier.dispatch(completeEvent).catch(() => {
    // fail-open
  });

  await postOrUpdate(vcs, ctx.ref, pr, result, previousState, {
    stateWriteRetries: inputs.stateWriteRetries,
    log,
    diff,
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
  let repoYaml: string | null = null;
  try {
    repoYaml = await readFn(configPath, 'utf8');
  } catch {
    repoYaml = null;
  }
  const overrides: Parameters<typeof resolveEffectiveConfig>[0]['env'] = {};
  if (env.REVIEW_AGENT_LANGUAGE) overrides.REVIEW_AGENT_LANGUAGE = env.REVIEW_AGENT_LANGUAGE;
  if (env.REVIEW_AGENT_PROVIDER) overrides.REVIEW_AGENT_PROVIDER = env.REVIEW_AGENT_PROVIDER;
  if (env.REVIEW_AGENT_MODEL) overrides.REVIEW_AGENT_MODEL = env.REVIEW_AGENT_MODEL;
  if (env.REVIEW_AGENT_MAX_USD_PER_PR)
    overrides.REVIEW_AGENT_MAX_USD_PER_PR = env.REVIEW_AGENT_MAX_USD_PER_PR;
  if (env.REVIEW_AGENT_MAX_STEPS) overrides.REVIEW_AGENT_MAX_STEPS = env.REVIEW_AGENT_MAX_STEPS;
  const { config } = resolveEffectiveConfig({ repoYaml, env: overrides });
  return config;
}

/**
 * Resolve the GitHub host the Action is running against. GitHub
 * Actions exports `GITHUB_SERVER_URL` (e.g. `https://github.com` for
 * SaaS, `https://ghe.example.com` for GHES); we parse it to the host
 * portion so the runner's URL allowlist refine (spec §7.3 #4) can
 * match links into the PR's own repo regardless of deployment.
 *
 * Falls back to `'github.com'` when the env var is missing or
 * unparseable — matches the historical assumption and keeps the
 * Action runnable in test harnesses that don't seed Actions env.
 */
function inferGithubHost(env: NodeJS.ProcessEnv): string {
  const serverUrl = env.GITHUB_SERVER_URL;
  if (!serverUrl) return 'github.com';
  try {
    return new URL(serverUrl).host;
  } catch {
    return 'github.com';
  }
}

/**
 * Load SARIF file contents for each configured external tool.
 * Unreadable paths are warned and skipped (review continues without them).
 */
async function loadExternalToolContents(
  tools: ReadonlyArray<{
    readonly name: string;
    readonly sarif_path: string;
    readonly merge_policy: 'tool_wins' | 'annotate' | 'ai_wins';
  }>,
  readFn: (p: string, enc: 'utf8') => Promise<string>,
  log: (msg: string, meta?: Record<string, unknown>) => void,
): Promise<
  Array<{ name: string; mergePolicy: 'tool_wins' | 'annotate' | 'ai_wins'; sarif: string }>
> {
  const result: Array<{
    name: string;
    mergePolicy: 'tool_wins' | 'annotate' | 'ai_wins';
    sarif: string;
  }> = [];
  for (const tool of tools) {
    try {
      const content = await readFn(tool.sarif_path, 'utf8');
      result.push({ name: tool.name, mergePolicy: tool.merge_policy, sarif: content });
    } catch {
      log(
        `external_tools: sarif_path '${tool.sarif_path}' for tool '${tool.name}' not found or unreadable — skipping`,
      );
    }
  }
  return result;
}

function defaultLogger(msg: string, meta?: Record<string, unknown>): void {
  /* v8 ignore start */
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
  /* v8 ignore stop */
}

function buildAnthropicProvider(apiKey: string, config: Config): LlmProvider {
  /* v8 ignore start */
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
  /* v8 ignore stop */
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
    readonly diff: Diff;
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
  // #152: forward per-file patch data so the GitHub adapter can validate
  // suggestion anchor lines against the diff hunk context window.
  const diffPayload = {
    files: opts.diff.files.map((f) => ({ path: f.path, patch: f.patch })),
  };
  await withRetry(
    () =>
      vcs.postReview(ref, {
        comments: result.comments,
        summary: result.summary,
        state,
        event: result.reviewEvent,
        diff: diffPayload,
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
