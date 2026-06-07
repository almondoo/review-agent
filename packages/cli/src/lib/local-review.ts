/**
 * Shared helper for the no-post review pipeline used by both
 * `review --local` and `dry-run --pr` (AC: reuse dry-run no-post pipeline).
 *
 * Responsibilities:
 *   - Build a ReviewJob from a local diff text + resolved config.
 *   - Run `runReview` against a caller-supplied provider (no VCS).
 *   - Print findings to stdout in the same format as dry-run.
 *   - Return the RunnerResult for the caller to act on (e.g. exit code).
 *
 * VCS is never touched here: no getPR, no postReview, no upsertStateComment.
 */

import type { ConfigResolutionLog } from '@review-agent/config';
import { type Config, mergeWithEnv, resolveEffectiveConfig } from '@review-agent/config';
import { SEVERITY_RANK, type Severity } from '@review-agent/core';
import type { LlmProvider } from '@review-agent/llm';
import { loadSkills, type RunnerResult, renderSkillsBlock, runReview } from '@review-agent/runner';
import type { ProgramIo } from '../io.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LocalReviewOpts = {
  /** Resolved diff text (unified patch). */
  readonly diffText: string;
  /** Directory to use as workspaceDir for the runner. */
  readonly workspaceDir: string;
  /** Path to .review-agent.yml (may be missing; treated as null). */
  readonly configPath: string;
  /** Minimum severity for non-zero exit (default 'major'). */
  readonly failOn: Severity;
  /** Friendly label shown in the output header (e.g. '(local trial)'). */
  readonly label: string;
  readonly language?: string;
  readonly profile?: string;
  readonly costCapUsd?: number;
  readonly env: NodeJS.ProcessEnv;
  readonly readFile: (p: string, enc: 'utf8') => Promise<string>;
  readonly createProvider: (apiKey: string, config: Config) => LlmProvider;
};

export type LocalReviewResult = {
  readonly status: 'reviewed' | 'auth_failed';
  readonly findings: number;
  readonly failingFindings: number;
  readonly costUsd: number;
};

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Run the no-post review pipeline against a local diff and print results.
 * Returns { status, findings, failingFindings, costUsd } — callers decide
 * the exit code from failingFindings.
 */
export async function runLocalReview(
  io: ProgramIo,
  opts: LocalReviewOpts,
): Promise<LocalReviewResult> {
  const apiKey = opts.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    io.stderr('ANTHROPIC_API_KEY is required for the default Anthropic provider.\n');
    return { status: 'auth_failed', findings: 0, failingFindings: 0, costUsd: 0 };
  }

  // --- Config resolution --------------------------------------------------
  const repoYaml = await readYamlText(opts.configPath, opts.readFile);
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

  const config = applyCliOverrides(baseConfig, opts);
  const provider = opts.createProvider(apiKey, config);

  // --- Skills -------------------------------------------------------------
  const skills = await loadSkills(config.skills, opts.workspaceDir, {
    readFile: opts.readFile,
  });
  const skillBlock = renderSkillsBlock(skills, { changedPaths: extractPaths(opts.diffText) });

  // --- Run review (no VCS) ------------------------------------------------
  const result: RunnerResult = await runReview(
    {
      jobId: `local:${opts.label}`,
      workspaceDir: opts.workspaceDir,
      diffText: opts.diffText,
      prMetadata: {
        title: opts.label,
        body: '',
        author: '(local)',
        baseRef: 'HEAD',
        labels: [],
        commitMessages: [],
      },
      previousState: null,
      profile: config.profile,
      changedPaths: extractPaths(opts.diffText),
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
      // Local mode: no real repo; use a sentinel so URL allowlist is
      // effectively closed (no own-repo URLs will be auto-allowed).
      prRepo: { host: 'localhost', owner: '(local)', repo: opts.label },
      resolutionLog,
    },
    provider,
    { logger: (msg) => io.stderr(`${msg}\n`) },
  );

  // --- Print results (no VCS writes) --------------------------------------
  printLocalResult(io, opts.label, result, resolutionLog);

  const failOn = opts.failOn;
  const floor = SEVERITY_RANK[failOn];
  const failingFindings = result.comments.filter((c) => SEVERITY_RANK[c.severity] >= floor).length;

  return {
    status: 'reviewed',
    findings: result.comments.length,
    failingFindings,
    costUsd: result.costUsd,
  };
}

// ---------------------------------------------------------------------------
// Output formatting (shared with dry-run style)
// ---------------------------------------------------------------------------

function printLocalResult(
  io: ProgramIo,
  label: string,
  result: RunnerResult,
  resolutionLog: ConfigResolutionLog,
): void {
  io.stdout(`\n=== Local Review Results ===\n`);
  io.stdout(`Target: ${label}\n`);
  io.stdout(`Config: primary=${resolutionLog.primarySource}\n`);
  io.stdout(`Model: ${result.model}\n`);
  io.stdout(
    `Tokens: ${result.tokensUsed.input} in / ${result.tokensUsed.output} out — $${result.costUsd.toFixed(4)}\n`,
  );

  // Exclusion report — populated by the runner cap/filter pipeline.
  /* v8 ignore start */
  if (result.exclusionReport !== undefined && result.exclusionReport.excludedFiles.length > 0) {
    io.stdout(`\n--- Exclusion Report ---\n`);
    if (result.exclusionReport.capsApplied.length > 0) {
      io.stdout(`Caps triggered: ${result.exclusionReport.capsApplied.join(', ')}\n`);
    }
    io.stdout(`Excluded files (${result.exclusionReport.excludedFiles.length}):\n`);
    for (const f of result.exclusionReport.excludedFiles) {
      io.stdout(`  [${f.reason}] ${f.path}\n`);
    }
  }
  /* v8 ignore stop */

  // Aborted — set when the LLM failed schema validation twice (spec §7.3 #4).
  /* v8 ignore start */
  if (result.aborted !== undefined) {
    io.stdout(`\n--- Review Aborted ---\n`);
    io.stdout(`Reason: ${result.aborted.reason}\n`);
    if (result.summary) io.stdout(`${result.summary}\n`);
    return;
  }
  /* v8 ignore stop */

  // Findings
  io.stdout(`\n--- Findings (${result.comments.length}) ---\n`);
  for (const c of result.comments) {
    const firstLine = c.body.split('\n')[0] ?? '';
    io.stdout(`  [${c.severity}] ${c.path}:${c.line} — ${firstLine}\n`);
  }
  /* v8 ignore next 3 */
  if (result.droppedDuplicates > 0) {
    io.stdout(`Dropped duplicates: ${result.droppedDuplicates}\n`);
  }
  /* v8 ignore next 3 */
  if (result.droppedByRuleset > 0) {
    io.stdout(`Dropped by ruleset: ${result.droppedByRuleset}\n`);
  }
  if (result.summary) io.stdout(`\nSummary:\n${result.summary}\n`);
  io.stdout('\n(local mode: no comments posted to any VCS)\n');
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

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

function applyCliOverrides(
  config: Config,
  opts: Pick<LocalReviewOpts, 'language' | 'profile'>,
): Config {
  let next = config;
  if (opts.language) {
    next = mergeWithEnv(next, { REVIEW_AGENT_LANGUAGE: opts.language });
  }
  if (opts.profile === 'chill' || opts.profile === 'assertive') {
    next = { ...next, profile: opts.profile };
  }
  return next;
}

/**
 * Extract changed file paths from a unified diff text.
 * Matches `diff --git a/<path> b/<path>` and `--- a/<path>` / `+++ b/<path>` lines.
 * Returns deduplicated list of paths (b-side / new paths).
 */
function extractPaths(diffText: string): string[] {
  const seen = new Set<string>();
  for (const line of diffText.split('\n')) {
    // Prefer `diff --git` b-side (new path after rename)
    const gitMatch = /^diff --git a\/.+ b\/(.+)$/.exec(line);
    if (gitMatch) {
      const p = gitMatch[1];
      if (p) seen.add(p);
      continue;
    }
    // Fall back to `+++ b/<path>` for plain patches without git header
    const plusMatch = /^\+\+\+ b\/(.+)$/.exec(line);
    if (plusMatch) {
      const p = plusMatch[1];
      if (p) seen.add(p);
    }
  }
  return [...seen];
}
