import { readFile as fsReadFile } from 'node:fs/promises';
import {
  type Config,
  type ConfigResolutionLog,
  mergeWithEnv,
  resolveEffectiveConfig,
} from '@review-agent/config';
import type { PR, PRRef, ReviewState, VCS } from '@review-agent/core';
import { createAnthropicProvider, type LlmProvider } from '@review-agent/llm';
import { createCodecommitVCS } from '@review-agent/platform-codecommit';
import { createGithubVCS } from '@review-agent/platform-github';
import {
  buildReviewState,
  loadSkills,
  type RunnerResult,
  renderSkillsBlock,
  runReview,
} from '@review-agent/runner';
import type { ProgramIo } from '../io.js';

export type ReviewPlatform = 'github' | 'codecommit';

export type RunReviewOpts = {
  readonly repo: string;
  readonly pr: number;
  readonly configPath: string;
  readonly post: boolean;
  readonly platform?: ReviewPlatform;
  readonly language?: string;
  readonly profile?: string;
  readonly costCapUsd?: number;
  readonly env: NodeJS.ProcessEnv;
  readonly readFile?: (p: string, enc: 'utf8') => Promise<string>;
  readonly createVCS?: (token: string | null, config: Config) => VCS;
  readonly createProvider?: (apiKey: string, config: Config) => LlmProvider;
  readonly confirm?: () => Promise<boolean>;
};

export type RunReviewResult = {
  readonly status: 'reviewed' | 'skipped' | 'auth_failed' | 'cancelled';
  readonly reason?: string;
  readonly postedComments: number;
  readonly costUsd: number;
};

export async function runReviewCommand(
  io: ProgramIo,
  opts: RunReviewOpts,
): Promise<RunReviewResult> {
  const platform: ReviewPlatform = opts.platform ?? 'github';

  let token: string | null = null;
  if (platform === 'github') {
    const t = opts.env.REVIEW_AGENT_GH_TOKEN ?? opts.env.GITHUB_TOKEN;
    if (!t) {
      io.stderr('REVIEW_AGENT_GH_TOKEN (or GITHUB_TOKEN) is required.\n');
      return { status: 'auth_failed', postedComments: 0, costUsd: 0 };
    }
    token = t;
  } else if (!opts.repo) {
    io.stderr('Missing required --repo for --platform codecommit\n');
    return { status: 'auth_failed', postedComments: 0, costUsd: 0 };
  }
  const apiKey = opts.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    io.stderr('ANTHROPIC_API_KEY is required for the default Anthropic provider.\n');
    return { status: 'auth_failed', postedComments: 0, costUsd: 0 };
  }

  const ref = parseRef(platform, opts.repo, opts.pr);
  const readFile = opts.readFile ?? defaultReadFile;

  // Load the raw YAML text (null when the file is absent or unreadable).
  const repoYaml = await readYamlText(opts.configPath, readFile);

  // Build env-var override bag from opts.env. resolveEffectiveConfig
  // calls mergeWithEnv internally, so env is applied exactly once here.
  // CLI-flag overrides (--lang, --profile, --cost-cap) are applied
  // afterward via applyCliOverrides — they are the highest-priority
  // layer (mirrors PR comment commands) and intentionally do not flow
  // through resolveEffectiveConfig so the log accurately reports the
  // YAML/env layer provenance before CLI flags are folded in.
  //
  // NOTE(#156): env-vs-config precedence (§10.2: config > env) is not
  // yet corrected — env currently overrides YAML. When #156 lands,
  // update the env application order inside resolveEffectiveConfig.
  //
  // TODO: action/server entry points should wire resolveEffectiveConfig
  // similarly so every runtime surface emits a ConfigResolutionLog.
  const envOverrides: Parameters<typeof resolveEffectiveConfig>[0]['env'] = {};
  if (opts.env.REVIEW_AGENT_LANGUAGE)
    envOverrides.REVIEW_AGENT_LANGUAGE = opts.env.REVIEW_AGENT_LANGUAGE;
  if (opts.env.REVIEW_AGENT_PROVIDER)
    envOverrides.REVIEW_AGENT_PROVIDER = opts.env.REVIEW_AGENT_PROVIDER;
  if (opts.env.REVIEW_AGENT_MODEL) envOverrides.REVIEW_AGENT_MODEL = opts.env.REVIEW_AGENT_MODEL;
  if (opts.env.REVIEW_AGENT_MAX_USD_PER_PR)
    envOverrides.REVIEW_AGENT_MAX_USD_PER_PR = opts.env.REVIEW_AGENT_MAX_USD_PER_PR;

  const { config: baseConfig, log: resolutionLog } = resolveEffectiveConfig({
    repoYaml,
    env: envOverrides,
  });

  // Apply highest-priority CLI flag overrides (--lang, --profile, etc.)
  // after YAML+env resolution. These are not recorded in resolutionLog
  // because they are equivalent to PR-comment-command overrides — ephemeral,
  // not version-controlled, and always the caller's explicit intent.
  const config = applyCliOverrides(baseConfig, opts);

  const vcs = (opts.createVCS ?? ((t, c) => defaultCreateVCS(platform, t, c)))(token, config);
  const pr = await vcs.getPR(ref);

  const skipReason = decideSkip(pr, config);
  if (skipReason) {
    io.stdout(`Skipped: ${skipReason}\n`);
    return { status: 'skipped', reason: skipReason, postedComments: 0, costUsd: 0 };
  }

  const provider = (opts.createProvider ?? ((key, cfg) => buildAnthropicProvider(key, cfg)))(
    apiKey,
    config,
  );

  const diff = await vcs.getDiff(ref);
  const diffText = diff.files.map((f) => `--- ${f.path}\n${f.patch ?? ''}`).join('\n');
  const previousState = await vcs.getStateComment(ref);

  const skills = await loadSkills(config.skills, '.', { readFile });
  const skillBlock = renderSkillsBlock(skills, {
    changedPaths: diff.files.map((f) => f.path),
  });

  const result = await runReview(
    {
      jobId: `${ref.owner}/${ref.repo}#${ref.number}`,
      workspaceDir: process.cwd(),
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
      costCapUsd: opts.costCapUsd ?? config.cost.max_usd_per_pr,
      minConfidence: config.reviews.min_confidence,
      requestChangesOn: config.reviews.request_changes_on,
      pathFilters: config.reviews.path_filters,
      maxFiles: config.reviews.max_files,
      maxDiffLines: config.reviews.max_diff_lines,
      privacy: {
        allowedUrlPrefixes: config.privacy.allowed_url_prefixes,
        denyPaths: config.privacy.deny_paths,
        redactPatterns: config.privacy.redact_patterns,
      },
      prRepo: resolvePrRepo(platform, ref, opts.env),
      // Pass resolution provenance so the onConfigResolution hook below
      // can log it at the start of the review (issue #146 AC2).
      resolutionLog,
    },
    provider,
    {
      onConfigResolution: (log) => {
        io.stderr(formatResolutionLog(log));
      },
    },
  );

  printResultSummary(io, ref, pr, result);

  if (!opts.post) {
    io.stdout('Run with --post to publish these comments to the PR.\n');
    return {
      status: 'reviewed',
      postedComments: 0,
      costUsd: result.costUsd,
    };
  }

  const confirmed = opts.confirm ? await opts.confirm() : true;
  if (!confirmed) {
    io.stdout('Cancelled — no comments were posted.\n');
    return { status: 'cancelled', postedComments: 0, costUsd: result.costUsd };
  }

  await postOrUpdate(vcs, ref, pr, result, previousState);
  io.stdout(`Posted ${result.comments.length} comments.\n`);
  return {
    status: 'reviewed',
    postedComments: result.comments.length,
    costUsd: result.costUsd,
  };
}

function parseRef(platform: ReviewPlatform, repo: string, prNumber: number): PRRef {
  if (platform === 'codecommit') {
    if (!repo || /[\s/]/.test(repo)) {
      throw new Error(
        `--repo for --platform codecommit must be a repository name (got '${repo}').`,
      );
    }
    return { platform: 'codecommit', owner: '', repo, number: prNumber };
  }
  const match = /^([^/\s]+)\/([^/\s]+)$/.exec(repo);
  if (!match) {
    throw new Error(`--repo must be in 'owner/repo' format (got '${repo}').`);
  }
  return {
    platform: 'github',
    owner: match[1] ?? '',
    repo: match[2] ?? '',
    number: prNumber,
  };
}

function defaultCreateVCS(platform: ReviewPlatform, token: string | null, config: Config): VCS {
  /* v8 ignore start */
  if (platform === 'codecommit') {
    return createCodecommitVCS({ approvalState: config.codecommit.approvalState });
  }
  if (!token) {
    throw new Error('GitHub token is required for --platform github.');
  }
  return createGithubVCS({ token });
  /* v8 ignore stop */
}

/**
 * Read the raw YAML text from the config file path.
 * Returns null when the file is missing or unreadable (config falls back
 * to org config or built-in defaults via resolveEffectiveConfig).
 */
async function readYamlText(
  configPath: string,
  readFile: (p: string, enc: 'utf8') => Promise<string>,
): Promise<string | null> {
  try {
    return await readFile(configPath, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Apply highest-priority CLI flag overrides (--lang, --profile) on top of
 * the already-resolved config. These are ephemeral caller overrides — not
 * version-controlled — so they are folded in after resolveEffectiveConfig
 * rather than inside it (mirrors "PR comment command" precedence, §10.2 #1).
 * mergeWithEnv is used here exclusively for the --lang flag path because it
 * already validates the language code; --profile is applied directly.
 *
 * NOTE: env vars are consumed once inside resolveEffectiveConfig. This
 * function must NOT re-read them from opts.env to avoid double-application.
 */
function applyCliOverrides(config: Config, opts: RunReviewOpts): Config {
  let next = config;
  if (opts.language) {
    // mergeWithEnv validates the language code via isSupportedLanguage and
    // throws ConfigError on unsupported values — reuse for type-safe narrowing.
    next = mergeWithEnv(next, { REVIEW_AGENT_LANGUAGE: opts.language });
  }
  if (opts.profile === 'chill' || opts.profile === 'assertive') {
    next = { ...next, profile: opts.profile };
  }
  return next;
}

/**
 * Format a ConfigResolutionLog as a concise single-line stderr message.
 * Example:
 *   config resolved: primary=repo-yaml org=false env=false sections=language:repo-yaml cost:default ...
 *
 * Callers (server, action) should wire their own formatters if they want
 * structured JSON output. The CLI uses this human-readable form.
 */
function formatResolutionLog(log: ConfigResolutionLog): string {
  const sectionSummary = Object.entries(log.sections)
    .map(([k, v]) => `${k}:${v}`)
    .join(' ');
  return `config resolved: primary=${log.primarySource} org=${log.orgYamlLoaded} env=${log.envApplied} [${sectionSummary}]\n`;
}

function decideSkip(pr: PR, config: Config): string | null {
  if (pr.draft && !config.reviews.auto_review.drafts) {
    return 'PR is in draft state and auto_review.drafts=false';
  }
  if (config.reviews.ignore_authors.includes(pr.author)) {
    return `Author '${pr.author}' is in ignore_authors`;
  }
  return null;
}

function buildAnthropicProvider(apiKey: string, config: Config): LlmProvider {
  /* v8 ignore start */
  return createAnthropicProvider({
    type: 'anthropic',
    model: config.provider?.model ?? 'claude-sonnet-4-6',
    apiKey,
    anthropicCacheControl: config.provider?.anthropic_cache_control ?? true,
  });
  /* v8 ignore stop */
}

function defaultReadFile(p: string, enc: 'utf8'): Promise<string> {
  /* v8 ignore start */
  return fsReadFile(p, enc as BufferEncoding).then(String);
  /* v8 ignore stop */
}

/**
 * Resolve the PR's host/owner/repo triple consumed by the URL
 * allowlist refine in `createReviewOutputSchema` (spec §7.3 #4).
 *
 * - GitHub: host comes from `GITHUB_SERVER_URL` (GHES) or falls back
 *   to `github.com`. Owner/repo come from the parsed `--repo` arg.
 * - CodeCommit: there is no single fixed PR-UI host (the AWS console
 *   URL is region-scoped, e.g.
 *   `<region>.console.aws.amazon.com/...`) and the PRRef's `owner`
 *   is empty by construction. We pass the literal sentinel host
 *   `'codecommit.invalid'` so the URL refine treats codecommit
 *   reviews as "no own-repo URLs"; operators who need allowlisted
 *   AWS console links should add them to `privacy.allowed_url_prefixes`.
 */
function resolvePrRepo(
  platform: ReviewPlatform,
  ref: PRRef,
  env: NodeJS.ProcessEnv,
): { host: string; owner: string; repo: string } {
  if (platform === 'codecommit') {
    return { host: 'codecommit.invalid', owner: ref.owner, repo: ref.repo };
  }
  return { host: inferGithubHost(env), owner: ref.owner, repo: ref.repo };
}

function inferGithubHost(env: NodeJS.ProcessEnv): string {
  const serverUrl = env.GITHUB_SERVER_URL;
  if (!serverUrl) return 'github.com';
  try {
    return new URL(serverUrl).host;
  } catch {
    return 'github.com';
  }
}

function printResultSummary(io: ProgramIo, ref: PRRef, pr: PR, result: RunnerResult): void {
  io.stdout(`PR ${ref.owner}/${ref.repo}#${ref.number}: ${pr.title}\n`);
  io.stdout(`Model: ${result.model}\n`);
  io.stdout(
    `Tokens: ${result.tokensUsed.input} in / ${result.tokensUsed.output} out — $${result.costUsd.toFixed(4)}\n`,
  );
  io.stdout(`Comments: ${result.comments.length}\n`);
  for (const c of result.comments) {
    const firstLine = c.body.split('\n')[0] ?? '';
    io.stdout(`  [${c.severity}] ${c.path}:${c.line} — ${firstLine}\n`);
  }
  if (result.summary) io.stdout(`\nSummary:\n${result.summary}\n`);
}

async function postOrUpdate(
  vcs: VCS,
  ref: PRRef,
  pr: PR,
  result: RunnerResult,
  previousState: ReviewState | null,
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
  await vcs.postReview(ref, {
    comments: result.comments,
    summary: result.summary,
    state,
    event: result.reviewEvent,
  });
  await vcs.upsertStateComment(ref, state);
}
