/**
 * `review-agent dry-run` command — config preview and no-post review.
 *
 * Two modes of operation:
 *
 *   1. Config-only (no `--pr`): resolve the effective config from the
 *      supplied YAML file plus env overrides and print every section's
 *      winning source (repo-yaml / org-yaml / env / default) to stdout.
 *      No VCS calls, no LLM calls.
 *
 *   2. Full pipeline (with `--pr`): run the complete review pipeline —
 *      path filtering, diff fetch, LLM call, dedup — but replace all
 *      VCS write calls (postReview, upsertStateComment) with no-ops.
 *      Prints the findings that *would* be posted and the exclusion
 *      report (path-filter hits, cap-skip files) so operators can tune
 *      caps without a real PR round-trip.
 *
 * Spec §10.2 (config precedence), §10.1 (path_filters / caps).
 * Issue #145.
 */

import { readFile as fsReadFile } from 'node:fs/promises';
import {
  type Config,
  type ConfigResolutionLog,
  mergeWithEnv,
  resolveEffectiveConfig,
} from '@review-agent/config';
import type { PRRef, VCS } from '@review-agent/core';
import { createAnthropicProvider, type LlmProvider } from '@review-agent/llm';
import { createGithubVCS } from '@review-agent/platform-github';
import { loadSkills, type RunnerResult, renderSkillsBlock, runReview } from '@review-agent/runner';
import type { ProgramIo } from '../io.js';
import type { ReviewPlatform } from './review.js';

export type DryRunOpts = {
  readonly configPath: string;
  /**
   * When present, fetch this PR's diff and run the full review pipeline
   * in no-post mode. Format: `owner/repo#<number>` (GitHub).
   */
  readonly pr?: string;
  readonly platform?: ReviewPlatform;
  readonly language?: string;
  readonly profile?: string;
  readonly env: NodeJS.ProcessEnv;
  readonly readFile?: (p: string, enc: 'utf8') => Promise<string>;
  /**
   * Factory injected in tests to avoid live VCS calls. Accepts the
   * GitHub token (null for platforms that don't need one) and the
   * resolved config.
   */
  readonly createVCS?: (token: string | null, config: Config) => VCS;
  /**
   * Factory injected in tests to avoid live LLM calls.
   */
  readonly createProvider?: (apiKey: string, config: Config) => LlmProvider;
};

export type DryRunResult = {
  readonly status: 'config_only' | 'reviewed' | 'auth_failed' | 'parse_error';
  readonly reason?: string;
};

/**
 * Config-only mode: resolve the effective config and print per-section
 * sources to stdout without any VCS or LLM calls.
 */
export async function runDryRunCommand(io: ProgramIo, opts: DryRunOpts): Promise<DryRunResult> {
  const readFile = opts.readFile ?? defaultReadFile;

  // --- Load and resolve config ----------------------------------------
  const repoYaml = await readYamlText(opts.configPath, readFile);
  const envOverrides: Parameters<typeof resolveEffectiveConfig>[0]['env'] = {};
  if (opts.env.REVIEW_AGENT_LANGUAGE)
    envOverrides.REVIEW_AGENT_LANGUAGE = opts.env.REVIEW_AGENT_LANGUAGE;
  if (opts.env.REVIEW_AGENT_PROVIDER)
    envOverrides.REVIEW_AGENT_PROVIDER = opts.env.REVIEW_AGENT_PROVIDER;
  if (opts.env.REVIEW_AGENT_MODEL) envOverrides.REVIEW_AGENT_MODEL = opts.env.REVIEW_AGENT_MODEL;
  if (opts.env.REVIEW_AGENT_MAX_USD_PER_PR)
    envOverrides.REVIEW_AGENT_MAX_USD_PER_PR = opts.env.REVIEW_AGENT_MAX_USD_PER_PR;
  if (opts.env.REVIEW_AGENT_MAX_STEPS)
    envOverrides.REVIEW_AGENT_MAX_STEPS = opts.env.REVIEW_AGENT_MAX_STEPS;

  const { config: baseConfig, log: resolutionLog } = resolveEffectiveConfig({
    repoYaml,
    env: envOverrides,
  });

  // Apply CLI flag overrides (--lang, --profile) at the highest priority.
  const config = applyCliOverrides(baseConfig, opts);

  // --- Print config resolution -----------------------------------------
  io.stdout(formatResolutionLog(resolutionLog, config));

  // --- Config-only mode: stop here if --pr was not supplied -----------
  if (opts.pr === undefined) {
    return { status: 'config_only' };
  }

  // --- PR mode: validate auth then run no-post pipeline ---------------
  const platform: ReviewPlatform = opts.platform ?? 'github';

  let token: string | null = null;
  if (platform === 'github') {
    const t = opts.env.REVIEW_AGENT_GH_TOKEN ?? opts.env.GITHUB_TOKEN;
    if (!t) {
      io.stderr('REVIEW_AGENT_GH_TOKEN (or GITHUB_TOKEN) is required for --pr mode.\n');
      return { status: 'auth_failed' };
    }
    token = t;
  }
  const apiKey = opts.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    io.stderr('ANTHROPIC_API_KEY is required for the default Anthropic provider.\n');
    return { status: 'auth_failed' };
  }

  let ref: PRRef;
  try {
    ref = parsePrArg(platform, opts.pr);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    io.stderr(`${msg}\n`);
    return { status: 'parse_error', reason: msg };
  }

  const vcs = (opts.createVCS ?? ((t, _c) => defaultCreateVCS(platform, t)))(token, config);
  const pr = await vcs.getPR(ref);

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

  // Load external SARIF tool contents (back-compat: no-op when tools list is empty).
  const externalTools = await loadExternalToolContents(
    config.external_tools.tools,
    readFile,
    (msg) => io.stderr(`${msg}\n`),
  );

  const result: RunnerResult = await runReview(
    {
      jobId: `dry-run:${ref.owner}/${ref.repo}#${ref.number}`,
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
      costCapUsd: config.cost.max_usd_per_pr,
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
      prRepo: resolvePrRepo(platform, ref, opts.env),
      resolutionLog,
      ...(externalTools.length > 0 ? { externalTools } : {}),
    },
    provider,
    // No onConfigResolution hook — we already printed the config above.
    { logger: (msg) => io.stderr(`${msg}\n`) },
  );

  // --- Print results (no VCS writes) -----------------------------------
  printDryRunResult(io, ref, pr, result);

  return { status: 'reviewed' };
}

// ---------------------------------------------------------------------------
// Output formatting
// ---------------------------------------------------------------------------

/**
 * Format a ConfigResolutionLog as a human-readable table.
 *
 * Example output:
 *
 *   === Effective Config (dry-run) ===
 *   primary source : repo-yaml
 *   org yaml loaded: false
 *   env applied    : false
 *
 *   Section               Source
 *   ──────────────────── ──────────
 *   language             repo-yaml
 *   profile              default
 *   ...
 */
function formatResolutionLog(log: ConfigResolutionLog, config: Config): string {
  const lines: string[] = [];
  lines.push('=== Effective Config (dry-run) ===');
  lines.push(`primary source : ${log.primarySource}`);
  lines.push(`org yaml loaded: ${log.orgYamlLoaded}`);
  lines.push(`env applied    : ${log.envApplied}`);
  lines.push('');
  lines.push('Section               Source');
  lines.push(`${'─'.repeat(20)} ${'─'.repeat(12)}`);
  for (const [section, source] of Object.entries(log.sections)) {
    const col1 = section.padEnd(20);
    lines.push(`${col1} ${source}`);
  }
  lines.push('');
  lines.push('--- Resolved values ---');
  lines.push(`language         : ${config.language}`);
  lines.push(`profile          : ${config.profile}`);
  lines.push(`cost.max_usd_per_pr: ${config.cost.max_usd_per_pr}`);
  lines.push(`reviews.max_files  : ${config.reviews.max_files}`);
  lines.push(`reviews.max_diff_lines: ${config.reviews.max_diff_lines}`);
  lines.push(`reviews.max_steps  : ${config.reviews.max_steps}`);
  const filterCount = config.reviews.path_filters.length;
  lines.push(
    `reviews.path_filters: ${filterCount === 0 ? '(none)' : config.reviews.path_filters.join(', ')}`,
  );
  lines.push('');
  return lines.join('\n');
}

function printDryRunResult(
  io: ProgramIo,
  ref: PRRef,
  pr: { title: string },
  result: RunnerResult,
): void {
  io.stdout(`\n=== Dry-Run Results ===\n`);
  io.stdout(`PR ${ref.owner}/${ref.repo}#${ref.number}: ${pr.title}\n`);
  io.stdout(`Model: ${result.model}\n`);
  io.stdout(
    `Tokens: ${result.tokensUsed.input} in / ${result.tokensUsed.output} out — $${result.costUsd.toFixed(4)}\n`,
  );

  // Exclusion report
  if (result.exclusionReport !== undefined && result.exclusionReport.excludedFiles.length > 0) {
    io.stdout(`\n--- Exclusion Report ---\n`);
    if (result.exclusionReport.capsApplied.length > 0) {
      io.stdout(`Caps triggered: ${result.exclusionReport.capsApplied.join(', ')}\n`);
    }
    io.stdout(`Excluded files (${result.exclusionReport.excludedFiles.length}):\n`);
    for (const f of result.exclusionReport.excludedFiles) {
      io.stdout(`  [${f.reason}] ${f.path}\n`);
    }
  } else {
    io.stdout(`\n--- Exclusion Report ---\n`);
    io.stdout(`No files excluded.\n`);
  }

  // Aborted (cap-skip or schema abort)
  if (result.aborted !== undefined) {
    io.stdout(`\n--- Review Aborted ---\n`);
    io.stdout(`Reason: ${result.aborted.reason}\n`);
    io.stdout(`${result.summary}\n`);
    return;
  }

  // Findings
  io.stdout(`\n--- Would-Be Findings (${result.comments.length}) ---\n`);
  for (const c of result.comments) {
    const firstLine = c.body.split('\n')[0] ?? '';
    io.stdout(`  [${c.severity}] ${c.path}:${c.line} — ${firstLine}\n`);
  }
  if (result.droppedDuplicates > 0) {
    io.stdout(`Dropped duplicates: ${result.droppedDuplicates}\n`);
  }
  if (result.droppedByRuleset > 0) {
    io.stdout(`Dropped by ruleset: ${result.droppedByRuleset}\n`);
  }

  if (result.summary) io.stdout(`\nSummary:\n${result.summary}\n`);
  io.stdout('\n(dry-run: no comments posted to PR)\n');
}

// ---------------------------------------------------------------------------
// Helpers (mirrors review.ts where applicable)
// ---------------------------------------------------------------------------

/**
 * Parse `--pr` argument. Format: `owner/repo#<number>` for GitHub,
 * `<name>#<number>` for CodeCommit.
 */
function parsePrArg(platform: ReviewPlatform, prArg: string): PRRef {
  if (platform === 'codecommit') {
    const match = /^([^#\s]+)#(\d+)$/.exec(prArg);
    if (!match) {
      throw new Error(`--pr for --platform codecommit must be '<repo>#<number>' (got '${prArg}').`);
    }
    return { platform: 'codecommit', owner: '', repo: match[1] ?? '', number: Number(match[2]) };
  }
  const match = /^([^/\s]+)\/([^#\s]+)#(\d+)$/.exec(prArg);
  if (!match) {
    throw new Error(`--pr must be in 'owner/repo#<number>' format (got '${prArg}').`);
  }
  return {
    platform: 'github',
    owner: match[1] ?? '',
    repo: match[2] ?? '',
    number: Number(match[3]),
  };
}

function applyCliOverrides(config: Config, opts: DryRunOpts): Config {
  let next = config;
  if (opts.language) {
    next = mergeWithEnv(next, { REVIEW_AGENT_LANGUAGE: opts.language });
  }
  if (opts.profile === 'chill' || opts.profile === 'assertive') {
    next = { ...next, profile: opts.profile };
  }
  return next;
}

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

function defaultCreateVCS(platform: ReviewPlatform, token: string | null): VCS {
  /* v8 ignore start */
  if (platform === 'codecommit') {
    throw new Error('CodeCommit dry-run requires an explicit createVCS factory.');
  }
  if (!token) {
    throw new Error('GitHub token is required for --platform github.');
  }
  return createGithubVCS({ token });
  /* v8 ignore stop */
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
 * Load SARIF file contents for each configured external tool.
 * Unreadable paths are warned and skipped (review continues without them).
 */
async function loadExternalToolContents(
  tools: ReadonlyArray<{
    readonly name: string;
    readonly sarif_path: string;
    readonly merge_policy: 'tool_wins' | 'annotate' | 'ai_wins';
  }>,
  readFile: (p: string, enc: 'utf8') => Promise<string>,
  warn: (msg: string) => void,
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
      const content = await readFile(tool.sarif_path, 'utf8');
      result.push({ name: tool.name, mergePolicy: tool.merge_policy, sarif: content });
    } catch {
      warn(
        `external_tools: sarif_path '${tool.sarif_path}' for tool '${tool.name}' not found or unreadable — skipping`,
      );
    }
  }
  return result;
}

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
