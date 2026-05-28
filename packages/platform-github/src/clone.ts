import { spawn } from 'node:child_process';
import type { CloneOpts, PRRef } from '@review-agent/core';

const SAFE_REF_REGEX = /^[A-Za-z0-9_./-]+$/;
const DEFAULT_DEPTH = 50;
const SPAWN_TIMEOUT_MS = 120_000;

export type RunGitOptions = {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
};

export type RunGit = (args: ReadonlyArray<string>, opts?: RunGitOptions) => Promise<void>;

export const defaultRunGit: RunGit = async (args, opts = {}) => {
  /* v8 ignore start */
  return new Promise((resolve, reject) => {
    const proc = spawn('git', [...args], {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: SPAWN_TIMEOUT_MS,
    });
    let stderr = '';
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`git ${args[0] ?? '?'} exited ${code}: ${stderr.trim()}`));
    });
  });
  /* v8 ignore stop */
};

function assertSafeRef(ref: string): void {
  if (!SAFE_REF_REGEX.test(ref)) {
    throw new Error(`Refusing potentially unsafe git ref: '${ref}'`);
  }
}

function buildCloneArgs(url: string, dest: string, opts: CloneOpts): string[] {
  const depth = opts.depth ?? DEFAULT_DEPTH;
  const args = ['clone', `--depth=${depth}`, '--no-checkout', '--no-tags'];
  if (opts.filter && opts.filter !== 'none') args.push(`--filter=${opts.filter}`);
  if (opts.submodules) args.push('--recurse-submodules', '--shallow-submodules');
  args.push('--', url, dest);
  return args;
}

/**
 * Spec §9.3: "LFS: disabled by default. Skip via env
 * `GIT_LFS_SKIP_SMUDGE=1`." When `opts.lfs` is not set to `true`, every
 * `git` subprocess inherits this env so the LFS smudge filter is a
 * no-op even if the host has `git-lfs` installed and the repository
 * declares `*.bin filter=lfs` patterns. We deliberately gate on
 * `=== true` so the default (undefined) follows the spec's "off by
 * default" stance without surprising opt-in.
 */
function lfsEnvFor(opts: CloneOpts): NodeJS.ProcessEnv | undefined {
  if (opts.lfs === true) return undefined;
  return { GIT_LFS_SKIP_SMUDGE: '1' };
}

export async function cloneWithStrategy(
  url: string,
  dest: string,
  ref: PRRef,
  headSha: string,
  opts: CloneOpts,
  runGit: RunGit = defaultRunGit,
): Promise<void> {
  assertSafeRef(headSha);
  const env = lfsEnvFor(opts);
  const runOpts: RunGitOptions = env ? { env } : {};
  await runGit(buildCloneArgs(url, dest, opts), runOpts);

  if (opts.sparsePaths && opts.sparsePaths.length > 0 && opts.sparsePaths.length <= 100) {
    await runGit(['-C', dest, 'sparse-checkout', 'init', '--cone'], runOpts);
    await runGit(['-C', dest, 'sparse-checkout', 'set', ...opts.sparsePaths], runOpts);
  }

  const depth = opts.depth ?? DEFAULT_DEPTH;
  await runGit(['-C', dest, 'fetch', 'origin', headSha, `--depth=${depth}`], runOpts);
  await runGit(['-C', dest, 'checkout', headSha], runOpts);

  void ref;
}
