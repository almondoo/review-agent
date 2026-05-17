import {
  type PlatformDefinition,
  type PRRef,
  platformId,
  registerPlatform,
} from '@review-agent/core';
import { type CodeCommitVCSOptions, createCodecommitVCS } from './adapter.js';

export const CODECOMMIT_PLATFORM_ID = platformId('codecommit');

/**
 * Parse a CodeCommit-style PR ref from a free-form descriptor.
 *
 * Accepted shapes (lossless for the CodeCommit case where there is no
 * owner-level namespace and `pullRequestId` is an integer):
 *
 * - `'<repo>#<number>'`
 * - `'arn:aws:codecommit:<region>:<account>:<repo>#<number>'`
 *
 * Returns a {@link PRRef} with `platform: 'codecommit'` and an empty
 * `owner` (CodeCommit has no owner-level namespace; the adapter sets
 * an empty string in its own ref shape too).
 */
function parseCodecommitRef(input: string): PRRef {
  const idx = input.lastIndexOf('#');
  if (idx < 1) {
    throw new Error(`Invalid CodeCommit ref '${input}'; expected '<repo>#<number>'.`);
  }
  const left = input.slice(0, idx);
  const right = input.slice(idx + 1);
  const number = Number.parseInt(right, 10);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`Invalid CodeCommit PR number in ref '${input}'.`);
  }
  const repo = left.startsWith('arn:aws:codecommit:') ? (left.split(':').pop() ?? '') : left;
  if (!repo) {
    throw new Error(`Invalid CodeCommit repository name in ref '${input}'.`);
  }
  return { platform: 'codecommit', owner: '', repo, number };
}

export const codecommitPlatform: PlatformDefinition = {
  id: CODECOMMIT_PLATFORM_ID,
  parseRef: parseCodecommitRef,
  create: (config: unknown) => createCodecommitVCS((config ?? {}) as CodeCommitVCSOptions),
};

registerPlatform(codecommitPlatform);
