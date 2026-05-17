import { _resetPlatformRegistryForTests, getPlatform, registerPlatform } from '@review-agent/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CODECOMMIT_PLATFORM_ID, codecommitPlatform } from './platform.js';

describe('codecommitPlatform — parseRef', () => {
  it('parses a bare "<repo>#<number>" ref', () => {
    const ref = codecommitPlatform.parseRef('demo-repo#42');
    expect(ref).toEqual({
      platform: 'codecommit',
      owner: '',
      repo: 'demo-repo',
      number: 42,
    });
  });

  it('parses an ARN-style ref by taking the trailing repo segment', () => {
    const ref = codecommitPlatform.parseRef(
      'arn:aws:codecommit:us-east-1:123456789012:demo-repo#7',
    );
    expect(ref).toEqual({
      platform: 'codecommit',
      owner: '',
      repo: 'demo-repo',
      number: 7,
    });
  });

  it('rejects refs without "#"', () => {
    expect(() => codecommitPlatform.parseRef('demo-repo')).toThrow(/expected '<repo>#<number>'/);
  });

  it('rejects refs with a non-numeric PR id', () => {
    expect(() => codecommitPlatform.parseRef('demo-repo#abc')).toThrow(
      /Invalid CodeCommit PR number/,
    );
  });

  it('rejects refs with PR number <= 0', () => {
    expect(() => codecommitPlatform.parseRef('demo-repo#0')).toThrow(
      /Invalid CodeCommit PR number/,
    );
  });

  it('rejects refs with an empty repo segment', () => {
    expect(() => codecommitPlatform.parseRef('#42')).toThrow(/expected '<repo>#<number>'/);
  });
});

describe('codecommitPlatform — registry registration', () => {
  beforeEach(() => {
    _resetPlatformRegistryForTests();
    registerPlatform(codecommitPlatform);
  });
  afterEach(() => {
    _resetPlatformRegistryForTests();
  });

  it('resolves under id "codecommit"', () => {
    expect(getPlatform(CODECOMMIT_PLATFORM_ID)).toBe(codecommitPlatform);
  });

  it('create() constructs a CodeCommit VCS with declared capabilities', () => {
    const vcs = codecommitPlatform.create({});
    expect(vcs.platform).toBe('codecommit');
    expect(vcs.capabilities.clone).toBe(false);
    expect(vcs.capabilities.stateComment).toBe('postgres-only');
  });
});
