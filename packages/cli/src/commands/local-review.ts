/**
 * `review --local` mode — VCS-credential-free local review.
 *
 * Diff sources (priority order):
 *   1. --sample    bundled sample fixture (≥3 review categories).
 *   2. --diff-file read a patch file from disk.
 *   3. --range     spawn `git diff <a..b>` in --path (or cwd).
 *   4. --local     spawn `git diff HEAD` (working-tree) in --path (or cwd).
 *
 * AC6: no VCS API calls (no getPR / postReview / upsertStateComment).
 * AC3: .review-agent.yml config / presets are honoured.
 * AC2: exit code non-zero when findings >= --fail-on severity threshold.
 *
 * Issue #135.
 */

import { readFile as fsReadFile } from 'node:fs/promises';
import type { Config } from '@review-agent/config';
import { SEVERITIES, type Severity } from '@review-agent/core';
import { createAnthropicProvider, type LlmProvider } from '@review-agent/llm';
import type { ProgramIo } from '../io.js';
import { runLocalReview } from '../lib/local-review.js';
import type { SpawnResult } from '../lib/spawn.js';

// ---------------------------------------------------------------------------
// Exported types
// ---------------------------------------------------------------------------

export type LocalReviewMode = 'sample' | 'diff-file' | 'range' | 'working-tree';

export type RunLocalReviewCommandOpts = {
  /** Diff source selection. */
  readonly mode: LocalReviewMode;
  /** --path: target directory (defaults to cwd). */
  readonly targetDir: string;
  /** --diff-file path (mode === 'diff-file'). */
  readonly diffFile?: string;
  /** --range value e.g. 'HEAD~1..HEAD' (mode === 'range'). */
  readonly range?: string;
  /** Path to .review-agent.yml (--config). */
  readonly configPath: string;
  /** --fail-on severity threshold (default 'major'). */
  readonly failOn: Severity;
  readonly language?: string;
  readonly profile?: string;
  readonly costCapUsd?: number;
  readonly env: NodeJS.ProcessEnv;
  // --- Test seams ---------------------------------------------------------
  readonly readFile?: (p: string, enc: 'utf8') => Promise<string>;
  readonly createProvider?: (apiKey: string, config: Config) => LlmProvider;
  /** Seam: spawn `git diff ...`; defaults to real child process spawn. */
  readonly spawnGit?: (args: string[], cwd: string) => Promise<SpawnResult>;
  /** Seam: read bundled sample diff; defaults to loading from assets/. */
  readonly readSampleDiff?: () => Promise<string>;
};

export type RunLocalReviewCommandResult = {
  readonly status: 'reviewed' | 'auth_failed' | 'diff_error';
  readonly exitCode: number;
  readonly findings: number;
  readonly failingFindings: number;
  readonly costUsd: number;
};

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function runLocalReviewCommand(
  io: ProgramIo,
  opts: RunLocalReviewCommandOpts,
): Promise<RunLocalReviewCommandResult> {
  const readFile = opts.readFile ?? defaultReadFile;
  const spawnGit = opts.spawnGit ?? defaultSpawnGit;
  const readSampleDiff = opts.readSampleDiff ?? defaultReadSampleDiff;
  const createProvider = opts.createProvider ?? buildAnthropicProvider;

  // --- Acquire diff text --------------------------------------------------
  let diffText: string;
  let label: string;

  try {
    switch (opts.mode) {
      case 'sample': {
        diffText = await readSampleDiff();
        label = '(sample)';
        break;
      }
      case 'diff-file': {
        if (!opts.diffFile) {
          io.stderr('--diff-file requires a file path.\n');
          return { status: 'diff_error', exitCode: 1, findings: 0, failingFindings: 0, costUsd: 0 };
        }
        diffText = await readFile(opts.diffFile, 'utf8');
        label = opts.diffFile;
        break;
      }
      case 'range': {
        if (!opts.range) {
          io.stderr('--range requires a value (e.g. HEAD~1..HEAD).\n');
          return { status: 'diff_error', exitCode: 1, findings: 0, failingFindings: 0, costUsd: 0 };
        }
        const result = await spawnGit(['diff', opts.range], opts.targetDir);
        if (!result.ok) {
          io.stderr(`git diff ${opts.range} failed: ${result.stderr}\n`);
          return { status: 'diff_error', exitCode: 1, findings: 0, failingFindings: 0, costUsd: 0 };
        }
        diffText = result.stdout;
        label = opts.range;
        break;
      }
      case 'working-tree': {
        const result = await spawnGit(['diff', 'HEAD'], opts.targetDir);
        if (!result.ok) {
          io.stderr(`git diff HEAD failed: ${result.stderr}\n`);
          return { status: 'diff_error', exitCode: 1, findings: 0, failingFindings: 0, costUsd: 0 };
        }
        diffText = result.stdout;
        label = opts.targetDir;
        break;
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    io.stderr(`Failed to read diff: ${msg}\n`);
    return { status: 'diff_error', exitCode: 1, findings: 0, failingFindings: 0, costUsd: 0 };
  }

  if (!diffText.trim()) {
    io.stdout('No diff to review.\n');
    return { status: 'reviewed', exitCode: 0, findings: 0, failingFindings: 0, costUsd: 0 };
  }

  // --- Run the no-post pipeline -------------------------------------------
  const reviewResult = await runLocalReview(io, {
    diffText,
    workspaceDir: opts.targetDir,
    configPath: opts.configPath,
    failOn: opts.failOn,
    label,
    env: opts.env,
    readFile,
    createProvider,
    ...(opts.language !== undefined ? { language: opts.language } : {}),
    ...(opts.profile !== undefined ? { profile: opts.profile } : {}),
    ...(opts.costCapUsd !== undefined ? { costCapUsd: opts.costCapUsd } : {}),
  });

  if (reviewResult.status === 'auth_failed') {
    return { status: 'auth_failed', exitCode: 1, findings: 0, failingFindings: 0, costUsd: 0 };
  }

  const exitCode = reviewResult.failingFindings > 0 ? 1 : 0;
  if (exitCode !== 0) {
    io.stderr(
      `${reviewResult.failingFindings} finding(s) at or above '${opts.failOn}' severity — exiting non-zero.\n`,
    );
  }

  return {
    status: 'reviewed',
    exitCode,
    findings: reviewResult.findings,
    failingFindings: reviewResult.failingFindings,
    costUsd: reviewResult.costUsd,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Validate a user-supplied --fail-on value; returns the severity or null. */
export function parseFailOn(raw: string): Severity | null {
  if ((SEVERITIES as ReadonlyArray<string>).includes(raw)) {
    return raw as Severity;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Private defaults (replaced by test seams)
// ---------------------------------------------------------------------------

function defaultReadFile(p: string, enc: 'utf8'): Promise<string> {
  /* v8 ignore start */
  return fsReadFile(p, enc as BufferEncoding).then(String);
  /* v8 ignore stop */
}

async function defaultSpawnGit(args: string[], cwd: string): Promise<SpawnResult> {
  /* v8 ignore start */
  const { spawnCommand } = await import('../lib/spawn.js');
  return spawnCommand('git', args, cwd);
  /* v8 ignore stop */
}

async function defaultReadSampleDiff(): Promise<string> {
  /* v8 ignore start */
  // Use import.meta.url so the asset path resolves correctly from the
  // bundled dist/ directory in both ESM and after tsup bundling.
  const { readFile } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const { resolve, dirname } = await import('node:path');
  const assetPath = resolve(dirname(fileURLToPath(import.meta.url)), '../assets/sample-diff.txt');
  return readFile(assetPath, 'utf8');
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
