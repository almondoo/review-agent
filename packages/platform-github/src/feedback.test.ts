import { describe, expect, it, vi } from 'vitest';
import { getReviewState, listReviewCommentReactions } from './feedback.js';

function makeOctokit(reactionsData: unknown[] = [], reviewState = 'dismissed') {
  return {
    rest: {
      reactions: {
        listForPullRequestReviewComment: vi.fn(async () => ({ data: reactionsData })),
      },
      pulls: {
        getReview: vi.fn(async () => ({ data: { state: reviewState } })),
      },
    },
  } as never;
}

describe('listReviewCommentReactions', () => {
  it('maps +1 to thumbs_up and -1 to thumbs_down', async () => {
    const octokit = makeOctokit([
      { content: '+1', user: { login: 'alice' }, created_at: '2026-05-18T00:00:00Z' },
      { content: '-1', user: { login: 'bob' }, created_at: '2026-05-18T01:00:00Z' },
    ]);
    const rows = await listReviewCommentReactions(octokit, {
      owner: 'o',
      repo: 'r',
      commentId: 1,
    });
    expect(rows).toEqual([
      { kind: 'thumbs_up', userLogin: 'alice', createdAt: '2026-05-18T00:00:00Z' },
      { kind: 'thumbs_down', userLogin: 'bob', createdAt: '2026-05-18T01:00:00Z' },
    ]);
  });

  it('drops noisy reactions (heart, laugh, eyes, etc.)', async () => {
    const octokit = makeOctokit([
      { content: 'heart', user: { login: 'a' }, created_at: 't' },
      { content: 'laugh', user: { login: 'b' }, created_at: 't' },
      { content: 'eyes', user: { login: 'c' }, created_at: 't' },
      { content: 'rocket', user: { login: 'd' }, created_at: 't' },
      { content: 'hooray', user: { login: 'e' }, created_at: 't' },
      { content: 'confused', user: { login: 'f' }, created_at: 't' },
    ]);
    const rows = await listReviewCommentReactions(octokit, {
      owner: 'o',
      repo: 'r',
      commentId: 1,
    });
    expect(rows).toEqual([]);
  });

  it('falls back to "unknown" when user.login is absent', async () => {
    const octokit = makeOctokit([
      { content: '+1', user: null, created_at: '2026-05-18T00:00:00Z' },
    ]);
    const rows = await listReviewCommentReactions(octokit, {
      owner: 'o',
      repo: 'r',
      commentId: 1,
    });
    expect(rows[0]?.userLogin).toBe('unknown');
  });
});

describe('getReviewState', () => {
  it('returns the review state string', async () => {
    const octokit = makeOctokit([], 'approved');
    const r = await getReviewState(octokit, {
      owner: 'o',
      repo: 'r',
      pullNumber: 1,
      reviewId: 99,
    });
    expect(r.state).toBe('approved');
  });
});
