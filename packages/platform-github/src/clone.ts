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

export const defaultRunGit: RunGit = async (args, opts = {}) =>
  new Promise((resolve, reject) => {
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

export async function cloneWithStrategy(
  url: string,
  dest: string,
  ref: PRRef,
  headSha: string,
  opts: CloneOpts,
  runGit: RunGit = defaultRunGit,
): Promise<void> {
  assertSafeRef(headSha);
  await runGit(buildCloneArgs(url, dest, opts));

  if (opts.sparsePaths && opts.sparsePaths.length > 0 && opts.sparsePaths.length <= 100) {
    await runGit(['-C', dest, 'sparse-checkout', 'init', '--cone']);
    await runGit(['-C', dest, 'sparse-checkout', 'set', ...opts.sparsePaths]);
  }

  const depth = opts.depth ?? DEFAULT_DEPTH;
  await runGit(['-C', dest, 'fetch', 'origin', headSha, `--depth=${depth}`]);
  await runGit(['-C', dest, 'checkout', headSha]);

  void ref;
}
