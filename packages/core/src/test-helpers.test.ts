import { describe, expect, it } from 'vitest';
import {
  createFakeVCS,
  createFakeVcsReader,
  createFakeVcsStateStore,
  createFakeVcsWriter,
  DEFAULT_FAKE_CAPABILITIES,
} from './test-helpers.js';

describe('createFakeVCS', () => {
  it('returns a fully-shaped VCS with default capabilities', async () => {
    const vcs = createFakeVCS();
    expect(vcs.platform).toBe('github');
    expect(vcs.capabilities).toEqual(DEFAULT_FAKE_CAPABILITIES);
    const pr = await vcs.getPR({ platform: 'github', owner: 'o', repo: 'r', number: 1 });
    expect(pr.title).toBe('');
    expect(pr.commitMessages).toEqual([]);
    const diff = await vcs.getDiff({ platform: 'github', owner: 'o', repo: 'r', number: 1 });
    expect(diff.files).toEqual([]);
    const file = await vcs.getFile(
      { platform: 'github', owner: 'o', repo: 'r', number: 1 },
      'x',
      'h',
    );
    expect(file.length).toBe(0);
    const existing = await vcs.getExistingComments({
      platform: 'github',
      owner: 'o',
      repo: 'r',
      number: 1,
    });
    expect(existing).toEqual([]);
    const state = await vcs.getStateComment({
      platform: 'github',
      owner: 'o',
      repo: 'r',
      number: 1,
    });
    expect(state).toBeNull();
    const summary = await vcs.postSummary(
      { platform: 'github', owner: 'o', repo: 'r', number: 1 },
      'body',
    );
    expect(summary).toEqual({ commentId: '' });
  });

  it('respects per-method overrides', async () => {
    const vcs = createFakeVCS({
      platform: 'codecommit',
      capabilities: {
        clone: false,
        stateComment: 'postgres-only',
        approvalEvent: 'codecommit',
        commitMessages: false,
      },
      postSummary: async () => ({ commentId: 'custom-id' }),
    });
    expect(vcs.platform).toBe('codecommit');
    expect(vcs.capabilities.clone).toBe(false);
    const out = await vcs.postSummary(
      { platform: 'codecommit', owner: '', repo: 'r', number: 1 },
      'b',
    );
    expect(out.commentId).toBe('custom-id');
  });
});

describe('narrow-role fakes', () => {
  const ref = { platform: 'github' as const, owner: 'o', repo: 'r', number: 1 };

  it('createFakeVcsReader exposes only read methods', async () => {
    const reader = createFakeVcsReader({ getFile: async () => Buffer.from('hi') });
    const buf = await reader.getFile(ref, 'x', 'h');
    expect(buf.toString()).toBe('hi');
    expect(typeof reader.getPR).toBe('function');
    expect(typeof reader.cloneRepo).toBe('function');
  });

  it('createFakeVcsReader uses defaults when no overrides are passed', async () => {
    const reader = createFakeVcsReader();
    expect((await reader.getPR(ref)).title).toBe('');
    expect((await reader.getDiff(ref)).files).toEqual([]);
    expect((await reader.getFile(ref, 'x', 'h')).length).toBe(0);
    expect(await reader.cloneRepo(ref, '/tmp/x', {})).toBeUndefined();
    expect(await reader.getExistingComments(ref)).toEqual([]);
  });

  it('createFakeVcsWriter exposes only write methods', async () => {
    const writer = createFakeVcsWriter({
      postSummary: async () => ({ commentId: 'w-1' }),
    });
    const out = await writer.postSummary(ref, 'body');
    expect(out.commentId).toBe('w-1');
    expect(typeof writer.postReview).toBe('function');
  });

  it('createFakeVcsWriter uses defaults when no overrides are passed', async () => {
    const writer = createFakeVcsWriter();
    expect(
      await writer.postReview(ref, {
        comments: [],
        summary: '',
        state: {
          schemaVersion: 1,
          lastReviewedSha: '',
          baseSha: '',
          reviewedAt: '',
          modelUsed: '',
          totalTokens: 0,
          totalCostUsd: 0,
          commentFingerprints: [],
        },
      }),
    ).toBeUndefined();
    expect((await writer.postSummary(ref, 'b')).commentId).toBe('');
  });

  it('createFakeVcsStateStore exposes only state methods', async () => {
    const store = createFakeVcsStateStore({
      getStateComment: async () => null,
    });
    expect(await store.getStateComment(ref)).toBeNull();
    expect(typeof store.upsertStateComment).toBe('function');
  });

  it('createFakeVcsStateStore uses defaults when no overrides are passed', async () => {
    const store = createFakeVcsStateStore();
    expect(await store.getStateComment(ref)).toBeNull();
    expect(
      await store.upsertStateComment(ref, {
        schemaVersion: 1,
        lastReviewedSha: '',
        baseSha: '',
        reviewedAt: '',
        modelUsed: '',
        totalTokens: 0,
        totalCostUsd: 0,
        commentFingerprints: [],
      }),
    ).toBeUndefined();
  });
});
