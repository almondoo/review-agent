import { readFile } from 'node:fs/promises';
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
import type { ActionInputs } from './inputs.js';

export type RunActionDeps = {
  readonly readFile?: (p: string, enc: 'utf8') => Promise<string>;
  readonly createVCS?: (token: string) => VCS;
  readonly createProvider?: (apiKey: string, config: Config) => LlmProvider;
  readonly env?: NodeJS.ProcessEnv;
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

  const provider = (deps.createProvider ?? ((key, cfg) => buildAnthropicProvider(key, cfg)))(
    inputs.anthropicApiKey ?? '',
    config,
  );

  const diff = await vcs.getDiff(ctx.ref);
  const diffText = diff.files.map((f) => `--- ${f.path}\n${f.patch ?? ''}`).join('\n');
  const previousState = await vcs.getStateComment(ctx.ref);

  const skills = await loadSkills(config.skills, '.', { readFile: readFn });
  const skillBlock = renderSkillsBlock(skills, {
    changedPaths: diff.files.map((f) => f.path),
  });

  const result = await runReview(
    {
      jobId: `${ctx.ref.owner}/${ctx.ref.repo}#${ctx.ref.number}`,
      workspaceDir: process.cwd(),
      diffText,
      prMetadata: { title: pr.title, body: pr.body, author: pr.author },
      previousState,
      profile: config.profile,
      pathInstructions: config.reviews.path_instructions.map((p) => ({
        pattern: p.path,
        text: p.instructions,
      })),
      skills: skillBlock ? [skillBlock] : [],
      language: config.language,
      costCapUsd: inputs.costCapUsd,
    },
    provider,
  );

  await postOrUpdate(vcs, ctx.ref, pr, result, previousState);

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
  });
  await vcs.upsertStateComment(ref, state);
}
