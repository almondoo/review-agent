import { Buffer } from 'node:buffer';
import type { ReviewPayload, ReviewState } from './review.js';
import type {
  CloneOpts,
  Diff,
  ExistingComment,
  GetDiffOpts,
  PR,
  PRRef,
  VCS,
  VcsCapabilities,
  VcsReader,
  VcsStateStore,
  VcsWriter,
} from './vcs.js';

/**
 * Default capabilities for fake VCS implementations used in tests.
 * Matches the GitHub adapter shape so test code does not need to
 * import a real adapter package. Override per-test when exercising
 * capability gating.
 */
export const DEFAULT_FAKE_CAPABILITIES: VcsCapabilities = {
  clone: true,
  stateComment: 'native',
  approvalEvent: 'github',
  commitMessages: true,
};

/**
 * Build a fake {@link VCS} for tests. Every method is a no-op /
 * default-value implementation; pass `overrides` to specialize the
 * methods the test cares about. The `platform` / `capabilities` pair
 * can be overridden together when exercising CodeCommit-style flows.
 *
 * This factory is intentionally permissive: it does NOT enforce
 * capability ↔ behavior consistency (e.g. you can return a clone from
 * a fake that advertises `clone: false`). Tests asserting that runtime
 * code respects the capability flag must do that check themselves.
 */
export function createFakeVCS(overrides: Partial<VCS> = {}): VCS {
  const base: VCS = {
    platform: 'github',
    capabilities: DEFAULT_FAKE_CAPABILITIES,
    getPR: async (ref: PRRef): Promise<PR> => ({
      ref,
      title: '',
      body: '',
      author: '',
      baseSha: '',
      headSha: '',
      baseRef: '',
      headRef: '',
      draft: false,
      labels: [],
      commitMessages: [],
      createdAt: '',
      updatedAt: '',
    }),
    getDiff: async (_ref: PRRef, _opts?: GetDiffOpts): Promise<Diff> => ({
      baseSha: '',
      headSha: '',
      files: [],
    }),
    getFile: async (_ref: PRRef, _path: string, _sha: string): Promise<Buffer> => Buffer.alloc(0),
    cloneRepo: async (_ref: PRRef, _dir: string, _opts: CloneOpts): Promise<void> => undefined,
    postReview: async (_ref: PRRef, _review: ReviewPayload): Promise<void> => undefined,
    postSummary: async (_ref: PRRef, _body: string): Promise<{ commentId: string }> => ({
      commentId: '',
    }),
    getExistingComments: async (_ref: PRRef): Promise<ReadonlyArray<ExistingComment>> => [],
    getStateComment: async (_ref: PRRef): Promise<ReviewState | null> => null,
    upsertStateComment: async (_ref: PRRef, _state: ReviewState): Promise<void> => undefined,
  };
  return { ...base, ...overrides };
}

/**
 * Build a fake that exposes only the read-side surface. Useful for
 * unit tests that depend on {@link VcsReader} narrowly (recover
 * commands, dedup readers) — the test does not have to stub
 * post / state-comment methods.
 */
export function createFakeVcsReader(overrides: Partial<VcsReader> = {}): VcsReader {
  const full = createFakeVCS();
  return {
    getPR: overrides.getPR ?? full.getPR,
    getDiff: overrides.getDiff ?? full.getDiff,
    getFile: overrides.getFile ?? full.getFile,
    cloneRepo: overrides.cloneRepo ?? full.cloneRepo,
    getExistingComments: overrides.getExistingComments ?? full.getExistingComments,
  };
}

/**
 * Build a fake write surface ({@link VcsWriter}). The default returns
 * a stable `commentId: ''` from `postSummary` and a no-op `postReview`.
 */
export function createFakeVcsWriter(overrides: Partial<VcsWriter> = {}): VcsWriter {
  const full = createFakeVCS();
  return {
    postReview: overrides.postReview ?? full.postReview,
    postSummary: overrides.postSummary ?? full.postSummary,
  };
}

/**
 * Build a fake state-store surface ({@link VcsStateStore}). By default
 * `getStateComment` returns `null` (fresh review) and
 * `upsertStateComment` is a no-op. Pass a `getStateComment` override
 * to drive incremental-review flows from a known previous state.
 */
export function createFakeVcsStateStore(overrides: Partial<VcsStateStore> = {}): VcsStateStore {
  const full = createFakeVCS();
  return {
    getStateComment: overrides.getStateComment ?? full.getStateComment,
    upsertStateComment: overrides.upsertStateComment ?? full.upsertStateComment,
  };
}
