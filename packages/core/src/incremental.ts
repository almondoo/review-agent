import { spawn } from 'node:child_process';
import type { ReviewState } from './review.js';

export type RunGit = (
  workspace: string,
  args: ReadonlyArray<string>,
  opts?: { readonly timeoutMs?: number },
) => Promise<string>;

const DEFAULT_GIT_TIMEOUT_MS = 10_000;
const TRANSIENT_RETRY_BACKOFF_MS = 250;

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

// Three buckets for git merge-base failures:
//   - 'auth':       credential / permission errors (FS perms on .git, SSH
//                   host-key, HTTP 401/403, password prompts). Operator
//                   needs to know; we still fall back to full review.
//   - 'transient':  network / timeout / temporary-failure errors. We retry
//                   once with a short backoff before falling back.
//   - 'permanent':  the previous head is genuinely gone (force-push, bad
//                   object, ambiguous revision). Existing fallback behavior.
export const INCREMENTAL_GIT_FAILURES = ['auth', 'transient', 'permanent'] as const;
export type IncrementalGitFailureReason = (typeof INCREMENTAL_GIT_FAILURES)[number];

export type IncrementalGitFailure = {
  readonly reason: IncrementalGitFailureReason;
  readonly args: ReadonlyArray<string>;
  readonly message: string;
  readonly retried: boolean;
};

const AUTH_ERROR_PATTERNS: ReadonlyArray<RegExp> = [
  /permission denied/i,
  /authentication failed/i,
  /could not read from remote/i,
  /unable to access/i,
  /host key verification failed/i,
  /could not read username/i,
  /\bhttp\/[\d.]+\s+40[13]\b/i,
];

const TRANSIENT_ERROR_PATTERNS: ReadonlyArray<RegExp> = [
  /timed out/i,
  /\btimeout\b/i,
  /could not resolve host/i,
  /temporary failure/i,
  /network is unreachable/i,
  /connection reset/i,
  /connection refused/i,
  /\bbad gateway\b|\bservice unavailable\b|\bgateway timeout\b/i,
  // defaultRunGit reports SIGTERM-killed processes with `failed (null): ...`
  // because `code` is null when the spawn timeout fires.
  /failed \(null\):/,
];

export function classifyGitError(message: string): IncrementalGitFailureReason {
  for (const p of AUTH_ERROR_PATTERNS) if (p.test(message)) return 'auth';
  for (const p of TRANSIENT_ERROR_PATTERNS) if (p.test(message)) return 'transient';
  return 'permanent';
}

export type ComputeDiffStrategyDeps = {
  readonly runGit?: RunGit;
  readonly onGitFailure?: (failure: IncrementalGitFailure) => void;
  // Injectable for fast deterministic tests; default sleeps via setTimeout.
  readonly delayMs?: (ms: number) => Promise<void>;
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
  const delayMs = deps.delayMs ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const mergeBase = async (a: string, b: string): Promise<string | null> => {
    const args = ['merge-base', a, b] as const;
    try {
      return await runGit(workspace, args);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const reason = classifyGitError(message);
      if (reason === 'transient') {
        await delayMs(TRANSIENT_RETRY_BACKOFF_MS);
        try {
          return await runGit(workspace, args);
        } catch (err2) {
          const m2 = err2 instanceof Error ? err2.message : String(err2);
          deps.onGitFailure?.({
            reason: classifyGitError(m2),
            args: [...args],
            message: m2,
            retried: true,
          });
          return null;
        }
      }
      deps.onGitFailure?.({ reason, args: [...args], message, retried: false });
      return null;
    }
  };

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
