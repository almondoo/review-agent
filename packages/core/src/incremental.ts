import { spawn } from 'node:child_process';
import type { ReviewState } from './review.js';

export type RunGit = (
  workspace: string,
  args: ReadonlyArray<string>,
  opts?: { readonly timeoutMs?: number },
) => Promise<string>;

const DEFAULT_GIT_TIMEOUT_MS = 10_000;

const defaultRunGit: RunGit = (workspace, args, opts) =>
  new Promise<string>((resolve, reject) => {
    const proc = spawn('git', ['-C', workspace, ...args], {
      timeout: opts?.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS,
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    proc.on('error', (err) => reject(err));
    proc.on('close', (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`git ${args.join(' ')} failed (${code}): ${stderr.trim()}`));
    });
  });

export type ComputeDiffStrategyDeps = {
  readonly runGit?: RunGit;
};

export type DiffStrategy = 'full' | { readonly since: string };

export async function computeDiffStrategy(
  workspace: string,
  prevState: ReviewState | null,
  current: { readonly baseSha: string; readonly headSha: string },
  deps: ComputeDiffStrategyDeps = {},
): Promise<DiffStrategy> {
  if (!prevState) return 'full';
  const previousHead = prevState.lastReviewedSha;
  const previousBase = prevState.baseSha;
  if (!previousHead || !previousBase) return 'full';

  const runGit = deps.runGit ?? defaultRunGit;
  const mergeBase = (a: string, b: string) =>
    runGit(workspace, ['merge-base', a, b]).catch(() => null);

  // Detect rebase / force-push: previous merge-base shifts.
  const [prevMb, currMb] = await Promise.all([
    mergeBase(previousBase, previousHead),
    mergeBase(current.baseSha, current.headSha),
  ]);
  if (!prevMb || !currMb) return 'full';
  if (prevMb !== currMb) return 'full';

  // Reachability: previous head must still be an ancestor of current head.
  // `git merge-base prev current` returns prev only when prev is reachable.
  const reachable = await mergeBase(previousHead, current.headSha);
  if (reachable !== previousHead) return 'full';
  return { since: previousHead };
}

export type ApplyLineShiftInput = {
  readonly path: string;
  readonly originalLine: number;
  readonly diffHunks: ReadonlyArray<DiffHunk>;
};

export type DiffHunk = {
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
};

// Maps an `originalLine` (in the file before the new commits) to the
// equivalent line number in the file after the new commits, by walking
// hunks. Returns null when the line was deleted.
//
// Used when re-anchoring a previously-posted fingerprinted comment to a
// newer head. GitHub's review API also accepts a `position` field which
// re-maps automatically; this helper is the local fallback / verifier.
export function shiftLineThroughHunks(
  originalLine: number,
  hunks: ReadonlyArray<DiffHunk>,
): number | null {
  let line = originalLine;
  for (const h of hunks) {
    const oldEnd = h.oldStart + h.oldLines - 1;
    if (originalLine < h.oldStart) break;
    if (originalLine >= h.oldStart && originalLine <= oldEnd) {
      // Inside the changed hunk; map proportionally if the lines exist
      // in the new revision, else the line was deleted.
      if (h.newLines === 0) return null;
      const offset = originalLine - h.oldStart;
      if (offset >= h.newLines) return null;
      return h.newStart + offset;
    }
    if (originalLine > oldEnd) {
      line += h.newLines - h.oldLines;
    }
  }
  return line > 0 ? line : null;
}
