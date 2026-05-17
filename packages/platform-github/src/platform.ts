import {
  type PlatformDefinition,
  type PRRef,
  platformId,
  registerPlatform,
} from '@review-agent/core';
import { createGithubVCS, type GithubVCSOptions } from './adapter.js';

export const GITHUB_PLATFORM_ID = platformId('github');

/**
 * Parse a GitHub-style PR ref from `'owner/repo#number'`. Throws on
 * malformed input; callers must catch.
 */
function parseGithubRef(input: string): PRRef {
  const idx = input.lastIndexOf('#');
  if (idx < 1) {
    throw new Error(`Invalid GitHub ref '${input}'; expected 'owner/repo#number'.`);
  }
  const left = input.slice(0, idx);
  const right = input.slice(idx + 1);
  const slash = left.indexOf('/');
  if (slash < 1 || slash === left.length - 1) {
    throw new Error(`Invalid GitHub repo segment in ref '${input}'.`);
  }
  const number = Number.parseInt(right, 10);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`Invalid GitHub PR number in ref '${input}'.`);
  }
  return {
    platform: 'github',
    owner: left.slice(0, slash),
    repo: left.slice(slash + 1),
    number,
  };
}

export const githubPlatform: PlatformDefinition = {
  id: GITHUB_PLATFORM_ID,
  parseRef: parseGithubRef,
  create: (config: unknown) => {
    if (!config || typeof config !== 'object') {
      throw new Error('githubPlatform.create requires a GithubVCSOptions config object.');
    }
    return createGithubVCS(config as GithubVCSOptions);
  },
};

registerPlatform(githubPlatform);
