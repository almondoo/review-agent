import { _resetPlatformRegistryForTests, getPlatform, registerPlatform } from '@review-agent/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GITHUB_PLATFORM_ID, githubPlatform } from './platform.js';

describe('githubPlatform — parseRef', () => {
  it('parses an "owner/repo#number" ref', () => {
    const ref = githubPlatform.parseRef('almondoo/review-agent#80');
    expect(ref).toEqual({
      platform: 'github',
      owner: 'almondoo',
      repo: 'review-agent',
      number: 80,
    });
  });

  it('rejects refs without "#"', () => {
    expect(() => githubPlatform.parseRef('almondoo/review-agent')).toThrow(
      /expected 'owner\/repo#number'/,
    );
  });

  it('rejects refs missing "/"', () => {
    expect(() => githubPlatform.parseRef('almondoo#80')).toThrow(/Invalid GitHub repo segment/);
  });

  it('rejects refs with an empty repo', () => {
    expect(() => githubPlatform.parseRef('almondoo/#80')).toThrow(/Invalid GitHub repo segment/);
  });

  it('rejects refs with PR number <= 0', () => {
    expect(() => githubPlatform.parseRef('almondoo/review-agent#0')).toThrow(
      /Invalid GitHub PR number/,
    );
  });

  it('rejects refs with non-numeric PR id', () => {
    expect(() => githubPlatform.parseRef('almondoo/review-agent#abc')).toThrow(
      /Invalid GitHub PR number/,
    );
  });
});

describe('githubPlatform — registry registration', () => {
  beforeEach(() => {
    _resetPlatformRegistryForTests();
    registerPlatform(githubPlatform);
  });
  afterEach(() => {
    _resetPlatformRegistryForTests();
  });

  it('resolves under id "github"', () => {
    expect(getPlatform(GITHUB_PLATFORM_ID)).toBe(githubPlatform);
  });

  it('create() rejects missing config (no token)', () => {
    expect(() => githubPlatform.create(undefined)).toThrow(
      /githubPlatform.create requires a GithubVCSOptions/,
    );
  });

  it('create() builds a GitHub VCS when given a token', () => {
    const vcs = githubPlatform.create({ token: 'sample-token' });
    expect(vcs.platform).toBe('github');
    expect(vcs.capabilities).toEqual({
      clone: true,
      stateComment: 'native',
      approvalEvent: 'github',
      commitMessages: true,
    });
  });
});
