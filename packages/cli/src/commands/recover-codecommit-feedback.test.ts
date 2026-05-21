import { appendFingerprintMarker, fingerprint } from '@review-agent/core';
import { describe, expect, it, vi } from 'vitest';
import { scrapeCodeCommitFeedback } from './recover-codecommit-feedback.js';

// v1.2 #110 — CodeCommit /feedback re-scrape tests.
//
// All tests use an in-memory mock of the CodeCommit SDK client's
// `send(cmd)` method. The mock dispatches based on the command's
// constructor name and returns the SDK-shaped payload.

type SeededComment = {
  commentId: string;
  content: string;
  inReplyTo?: string;
  creationDate?: Date;
};

function makeClient(seed: { prIds?: string[]; commentsByPr?: Record<string, SeededComment[]> }) {
  const prIds = seed.prIds ?? [];
  const commentsByPr = seed.commentsByPr ?? {};
  return {
    send: vi.fn(async (cmd: { constructor: { name: string }; input?: unknown }) => {
      const name = cmd.constructor.name;
      if (name === 'ListPullRequestsCommand') {
        return { pullRequestIds: prIds };
      }
      if (name === 'GetCommentsForPullRequestCommand') {
        const input = cmd.input as { pullRequestId?: string };
        const id = input.pullRequestId ?? '';
        return {
          commentsForPullRequestData: [{ comments: commentsByPr[id] ?? [] }],
        };
      }
      throw new Error(`Unmocked SDK command: ${name}`);
    }),
    // biome-ignore lint/suspicious/noExplicitAny: stubbed SDK client shape
  } as any;
}

describe('scrapeCodeCommitFeedback (#110)', () => {
  it('resolves a /feedback reject reply to its parent Bot comment via the fingerprint marker (#96)', async () => {
    const fp = fingerprint({
      path: 'src/a.ts',
      line: 1,
      ruleId: 'sql-injection',
      suggestionType: 'comment',
    });
    const botBody = appendFingerprintMarker('Use parameterized query.', fp);
    const client = makeClient({
      prIds: ['7'],
      commentsByPr: {
        '7': [
          { commentId: 'c1', content: botBody, creationDate: new Date('2026-05-10T00:00:00Z') },
          {
            commentId: 'c2',
            content: '/feedback reject',
            inReplyTo: 'c1',
            creationDate: new Date('2026-05-11T00:00:00Z'),
          },
        ],
      },
    });
    const result = await scrapeCodeCommitFeedback({
      client,
      repositoryName: 'demo',
      sleep: async () => undefined,
    });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.factType).toBe('rejected_finding');
    expect(result.candidates[0]?.factText.startsWith(`[fp:${fp}] `)).toBe(true);
    expect(result.stats.resolved).toBe(1);
    expect(result.stats.unresolved).toBe(0);
    expect(result.stats.feedbackCommandsSeen).toBe(1);
  });

  it('classifies /feedback accept / reject / dismiss via feedbackKindToFactType', async () => {
    const fp = fingerprint({
      path: 'src/b.ts',
      line: 5,
      ruleId: 'sql-injection',
      suggestionType: 'comment',
    });
    const botBody = appendFingerprintMarker('finding', fp);
    const client = makeClient({
      prIds: ['9'],
      commentsByPr: {
        '9': [
          { commentId: 'b1', content: botBody },
          { commentId: 'b2', content: '/feedback accept', inReplyTo: 'b1' },
          { commentId: 'b3', content: '/feedback reject', inReplyTo: 'b1' },
          { commentId: 'b4', content: '/feedback dismiss', inReplyTo: 'b1' },
        ],
      },
    });
    const result = await scrapeCodeCommitFeedback({
      client,
      repositoryName: 'demo',
      sleep: async () => undefined,
    });
    // feedbackKindToFactType collapses thumbs_down + dismissed into
    // `rejected_finding`; only thumbs_up gets `accepted_pattern`.
    const factTypes = result.candidates.map((c) => c.factType).sort();
    expect(factTypes).toEqual(['accepted_pattern', 'rejected_finding', 'rejected_finding']);
  });

  it('counts /feedback comments without inReplyTo as unresolved (no parent to lift marker from)', async () => {
    const client = makeClient({
      prIds: ['11'],
      commentsByPr: {
        '11': [
          // /feedback at top-level, no inReplyTo.
          { commentId: 'top', content: '/feedback reject' },
        ],
      },
    });
    const result = await scrapeCodeCommitFeedback({
      client,
      repositoryName: 'demo',
      sleep: async () => undefined,
    });
    expect(result.candidates).toHaveLength(0);
    expect(result.stats.unresolved).toBe(1);
  });

  it('counts /feedback reply to a non-bot comment (no marker) as unresolved', async () => {
    const client = makeClient({
      prIds: ['13'],
      commentsByPr: {
        '13': [
          { commentId: 'humanC', content: 'Looks good to me' },
          { commentId: 'reply', content: '/feedback reject', inReplyTo: 'humanC' },
        ],
      },
    });
    const result = await scrapeCodeCommitFeedback({
      client,
      repositoryName: 'demo',
      sleep: async () => undefined,
    });
    expect(result.candidates).toHaveLength(0);
    expect(result.stats.unresolved).toBe(1);
  });

  it('skips /feedback older than --since (when sinceDate is provided)', async () => {
    const fp = fingerprint({
      path: 'src/c.ts',
      line: 1,
      ruleId: 'sql-injection',
      suggestionType: 'comment',
    });
    const client = makeClient({
      prIds: ['15'],
      commentsByPr: {
        '15': [
          {
            commentId: 'p',
            content: appendFingerprintMarker('finding', fp),
            creationDate: new Date('2026-05-01T00:00:00Z'),
          },
          {
            commentId: 'oldFb',
            content: '/feedback reject',
            inReplyTo: 'p',
            creationDate: new Date('2026-05-02T00:00:00Z'),
          },
          {
            commentId: 'newFb',
            content: '/feedback accept',
            inReplyTo: 'p',
            creationDate: new Date('2026-05-15T00:00:00Z'),
          },
        ],
      },
    });
    const result = await scrapeCodeCommitFeedback({
      client,
      repositoryName: 'demo',
      sinceDate: new Date('2026-05-10T00:00:00Z'),
      sleep: async () => undefined,
    });
    // Only the post-since `/feedback accept` should resolve.
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.factType).toBe('accepted_pattern');
  });

  it('respects --pr <n> to scope a single-PR debug walk', async () => {
    const fp = fingerprint({
      path: 'src/d.ts',
      line: 1,
      ruleId: 'sql-injection',
      suggestionType: 'comment',
    });
    const client = makeClient({
      prIds: ['100', '101', '102'], // pretend the repo has 3 PRs
      commentsByPr: {
        '101': [
          { commentId: 'a', content: appendFingerprintMarker('finding', fp) },
          { commentId: 'b', content: '/feedback reject', inReplyTo: 'a' },
        ],
      },
    });
    const result = await scrapeCodeCommitFeedback({
      client,
      repositoryName: 'demo',
      onlyPr: 101,
      sleep: async () => undefined,
    });
    // ListPullRequests should NOT have been called (single-PR path).
    expect(
      client.send.mock.calls.some((c) => c[0].constructor.name === 'ListPullRequestsCommand'),
    ).toBe(false);
    expect(result.candidates).toHaveLength(1);
    expect(result.stats.prsWalked).toBe(1);
  });

  it('paces between PRs via sleep() when there are multiple PRs', async () => {
    const sleep = vi.fn(async () => undefined);
    const client = makeClient({
      prIds: ['1', '2'],
      commentsByPr: {
        '1': [],
        '2': [],
      },
    });
    await scrapeCodeCommitFeedback({
      client,
      repositoryName: 'demo',
      sleep,
      delayMs: 250,
    });
    // At minimum one inter-PR pace call.
    expect(sleep).toHaveBeenCalled();
  });
});
