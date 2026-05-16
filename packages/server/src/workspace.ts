import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Diff, PRRef, VCS, WorkspaceStrategy } from '@review-agent/core';

// `WORKSPACE_STRATEGIES` lives in `@review-agent/core` so both the
// config schema (which validates `.review-agent.yml`) and this
// provisioner (which dispatches on the strategy) can reference the
// same set of literals without `server → config` or
// `config → server` cross-deps.
export type { WorkspaceStrategy };

/**
 * Same deny-list as `runner/src/tools.ts`. Reproduced here so the
 * provisioner refuses to materialize denylisted files even when the
 * diff would otherwise include them — defense-in-depth against a
 * malicious PR that adds a `.env` and waits for the agent to read it.
 * The runner's tool dispatcher is the actual enforcement layer; this
 * is a redundant pre-filter so denylisted paths never hit disk in
 * the worker workspace.
 */
const DENY_PATTERNS: ReadonlyArray<RegExp> = [
  /(^|\/)\.env(\..*)?$/,
  /(^|\/)secrets?(\/|$)/i,
  /(^|\/)private(\/|$)/i,
  /(^|\/)credentials?(\/|$)/i,
  /\.(key|pem|p12|pfx)$/i,
  /credentials.*\.json$/i,
  /service-account.*\.json$/i,
  // Keep this 8-entry list in sync with `runner/src/tools.ts`'s
  // DENY_PATTERNS. Reviewer flagged drift in #63 I-1: a missing entry
  // here meant the bytes would hit disk in the worker tmpdir before
  // the runner's tool dispatcher refused to read them, leaving a
  // warm-Lambda residue window. Wave-end follow-up M-2 will extract
  // the shared list to `@review-agent/core` so both packages import
  // a single source.
  /^\.aws\/credentials$/,
];

const TRAVERSAL = /(^|\/)\.\.(\/|$)/;

function pathIsAllowed(rel: string): boolean {
  if (!rel) return false;
  if (rel.startsWith('/')) return false;
  if (rel.startsWith('~')) return false;
  if (TRAVERSAL.test(rel)) return false;
  if (rel.includes('\0')) return false;
  return !DENY_PATTERNS.some((p) => p.test(rel));
}

export type WorkspaceHandle = {
  /**
   * Absolute path to the provisioned workspace root. Empty string
   * when `strategy: 'none'` — callers pass this as
   * `ReviewJob.workspaceDir` regardless; the runner's tool dispatcher
   * refuses every path that escapes the (empty) workspace, which is
   * the v0.2 no-tools behavior.
   */
  readonly dir: string;
  /** Idempotent cleanup. Safe to call multiple times. */
  readonly cleanup: () => Promise<void>;
};

export type ProvisionWorkspaceDeps = {
  readonly mkdtemp?: typeof mkdtemp;
  readonly mkdir?: typeof mkdir;
  readonly writeFile?: typeof writeFile;
  readonly rm?: typeof rm;
  readonly tmpdir?: () => string;
};

export type ProvisionWorkspaceInput = {
  readonly strategy: WorkspaceStrategy;
  readonly vcs: VCS;
  readonly ref: PRRef;
  readonly headSha: string;
  readonly diff: Diff;
};

/**
 * Materialize a per-job workspace and return a handle the caller
 * must `cleanup()` in a `try/finally`.
 *
 * The function never throws once the workspace dir is created — if
 * the strategy-specific provisioning step fails, cleanup runs and
 * the original error re-throws so the worker sees a usable trace.
 */
export async function provisionWorkspace(
  input: ProvisionWorkspaceInput,
  deps: ProvisionWorkspaceDeps = {},
): Promise<WorkspaceHandle> {
  if (input.strategy === 'none') {
    return { dir: '', cleanup: async () => undefined };
  }
  const mkdtempFn = deps.mkdtemp ?? mkdtemp;
  const rmFn = deps.rm ?? rm;
  const tmp = (deps.tmpdir ?? tmpdir)();
  const dir = await mkdtempFn(join(tmp, 'review-agent-ws-'));
  let cleaned = false;
  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    await rmFn(dir, { recursive: true, force: true });
  };
  try {
    if (input.strategy === 'sparse-clone') {
      await sparseClone(input, dir);
    } else {
      await contentsApiFetch(input, dir, deps);
    }
    return { dir, cleanup };
  } catch (err) {
    await cleanup();
    throw err;
  }
}

async function sparseClone(input: ProvisionWorkspaceInput, dir: string): Promise<void> {
  // Delegate to the VCS adapter so we share the same shelled-out
  // git plumbing as Action mode (cloneWithStrategy in
  // platform-github). Sparse paths come from the diff so we only
  // materialize the directories the LLM may need to read.
  //
  // Capability gate: refuse before touching the adapter when the
  // platform advertises no clone support (CodeCommit). The adapter's
  // own `cloneRepo` throws as defense-in-depth; this check produces a
  // clearer operator-facing error that names the config decision
  // ("strategy: 'sparse-clone' requires clone capability") rather
  // than the lower-level "CodeCommit clone is not supported" message.
  if (!input.vcs.capabilities.clone) {
    throw new Error(
      `workspace strategy 'sparse-clone' requires VCS clone capability, ` +
        `but platform '${input.vcs.platform}' advertises clone: false. ` +
        `Use strategy: 'contents-api' or 'none' for this platform.`,
    );
  }
  const sparsePaths = uniqueParentDirs(
    input.diff.files.filter((f) => pathIsAllowed(f.path)).map((f) => f.path),
  );
  const opts: { depth: number; filter: 'blob:none'; sparsePaths?: ReadonlyArray<string> } = {
    depth: 1,
    filter: 'blob:none',
  };
  if (sparsePaths.length > 0) {
    opts.sparsePaths = sparsePaths;
  }
  await input.vcs.cloneRepo(input.ref, dir, opts);
}

async function contentsApiFetch(
  input: ProvisionWorkspaceInput,
  dir: string,
  deps: ProvisionWorkspaceDeps,
): Promise<void> {
  const writeFn = deps.writeFile ?? writeFile;
  const mkdirFn = deps.mkdir ?? mkdir;
  for (const file of input.diff.files) {
    // Removed files have nothing to fetch — they're gone at headSha.
    // Renames write the new path; the old path is skipped (it's
    // covered as `previousPath` on the diff entry and read-only by
    // the LLM, not needed under tools).
    if (file.status === 'removed') continue;
    if (!pathIsAllowed(file.path)) continue;
    const buf = await input.vcs.getFile(input.ref, file.path, input.headSha);
    const dest = join(dir, file.path);
    await mkdirFn(dirname(dest), { recursive: true });
    await writeFn(dest, buf);
  }
}

function uniqueParentDirs(paths: ReadonlyArray<string>): ReadonlyArray<string> {
  // Sparse-checkout works on directory patterns. Collapse paths to
  // their immediate parent directories and de-duplicate so the
  // checkout patterns are bounded.
  const set = new Set<string>();
  for (const p of paths) {
    const idx = p.lastIndexOf('/');
    set.add(idx >= 0 ? p.slice(0, idx) : '/');
  }
  return [...set];
}
