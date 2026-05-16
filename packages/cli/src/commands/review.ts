import { readFile as fsReadFile } from 'node:fs/promises';
import { type Config, defaultConfig, loadConfigFromYaml, mergeWithEnv } from '@review-agent/config';
import type { PR, PRRef, ReviewState, VCS } from '@review-agent/core';
import { createAnthropicProvider, type LlmProvider } from '@review-agent/llm';
import { createGithubVCS } from '@review-agent/platform-github';
import {
  buildReviewState,
  loadSkills,
  type RunnerResult,
  renderSkillsBlock,
  runReview,
} from '@review-agent/runner';
import type { ProgramIo } from '../io.js';

export type RunReviewOpts = {
  readonly repo: string;
  readonly pr: number;
  readonly configPath: string;
  readonly post: boolean;
  readonly language?: string;
  readonly profile?: string;
  readonly costCapUsd?: number;
  readonly env: NodeJS.ProcessEnv;
  readonly readFile?: (p: string, enc: 'utf8') => Promise<string>;
  readonly createVCS?: (token: string) => VCS;
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
  const token = opts.env.REVIEW_AGENT_GH_TOKEN ?? opts.env.GITHUB_TOKEN;
  if (!token) {
    io.stderr('REVIEW_AGENT_GH_TOKEN (or GITHUB_TOKEN) is required.\n');
    return { status: 'auth_failed', postedComments: 0, costUsd: 0 };
  }
  const apiKey = opts.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    io.stderr('ANTHROPIC_API_KEY is required for the default Anthropic provider.\n');
    return { status: 'auth_failed', postedComments: 0, costUsd: 0 };
  }

  const ref = parseRepo(opts.repo, opts.pr);
  const readFile = opts.readFile ?? defaultReadFile;
  const config = applyOverrides(await loadConfig(opts.configPath, readFile), opts);

  const vcs = (opts.createVCS ?? ((t) => createGithubVCS({ token: t })))(token);
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
    },
    provider,
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

function parseRepo(repo: string, prNumber: number): PRRef {
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

async function loadConfig(
  configPath: string,
  readFile: (p: string, enc: 'utf8') => Promise<string>,
): Promise<Config> {
  try {
    const text = await readFile(configPath, 'utf8');
    return loadConfigFromYaml(text);
  } catch {
    return defaultConfig();
  }
}

function applyOverrides(config: Config, opts: RunReviewOpts): Config {
  const envOverrides: {
    REVIEW_AGENT_LANGUAGE?: string;
    REVIEW_AGENT_PROVIDER?: string;
    REVIEW_AGENT_MODEL?: string;
    REVIEW_AGENT_MAX_USD_PER_PR?: string;
  } = {};
  if (opts.env.REVIEW_AGENT_LANGUAGE)
    envOverrides.REVIEW_AGENT_LANGUAGE = opts.env.REVIEW_AGENT_LANGUAGE;
  if (opts.env.REVIEW_AGENT_PROVIDER)
    envOverrides.REVIEW_AGENT_PROVIDER = opts.env.REVIEW_AGENT_PROVIDER;
  if (opts.env.REVIEW_AGENT_MODEL) envOverrides.REVIEW_AGENT_MODEL = opts.env.REVIEW_AGENT_MODEL;
  if (opts.env.REVIEW_AGENT_MAX_USD_PER_PR)
    envOverrides.REVIEW_AGENT_MAX_USD_PER_PR = opts.env.REVIEW_AGENT_MAX_USD_PER_PR;
  let next = mergeWithEnv(config, envOverrides);
  if (opts.language) next = mergeWithEnv(next, { REVIEW_AGENT_LANGUAGE: opts.language });
  if (opts.profile === 'chill' || opts.profile === 'assertive') {
    next = { ...next, profile: opts.profile };
  }
  return next;
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
  return createAnthropicProvider({
    type: 'anthropic',
    model: config.provider?.model ?? 'claude-sonnet-4-6',
    apiKey,
    anthropicCacheControl: config.provider?.anthropic_cache_control ?? true,
  });
}

function defaultReadFile(p: string, enc: 'utf8'): Promise<string> {
  return fsReadFile(p, enc as BufferEncoding).then(String);
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
