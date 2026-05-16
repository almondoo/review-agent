import {
  GetCommentsForPullRequestCommand,
  GetFileCommand,
  GetPullRequestCommand,
  PostCommentForPullRequestCommand,
  type UpdatePullRequestApprovalStateCommand,
} from '@aws-sdk/client-codecommit';
import type { PRRef, ReviewEvent, ReviewPayload, ReviewState } from '@review-agent/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCodecommitVCS } from './adapter.js';

const REF: PRRef = { platform: 'codecommit', owner: 'me', repo: 'demo-repo', number: 7 };

function fakeClient(handlers: Record<string, (input: unknown) => unknown>) {
  return {
    send: vi.fn(async (cmd: { constructor: { name: string }; input: unknown }) => {
      const handler = handlers[cmd.constructor.name];
      if (!handler) throw new Error(`No handler for ${cmd.constructor.name}`);
      return handler(cmd.input);
    }),
  };
}

describe('createCodecommitVCS — getPR', () => {
  it('maps PullRequest fields and surfaces source/destination commits', async () => {
    const client = fakeClient({
      GetPullRequestCommand: () => ({
        pullRequest: {
          pullRequestId: '7',
          title: 'feat: x',
          description: 'body',
          authorArn: 'arn:aws:iam::123:user/jane',
          creationDate: new Date('2026-04-01T00:00:00Z'),
          lastActivityDate: new Date('2026-04-02T00:00:00Z'),
          pullRequestStatus: 'OPEN',
          pullRequestTargets: [
            {
              repositoryName: 'demo-repo',
              sourceCommit: 'h1',
              destinationCommit: 'b1',
              sourceReference: 'refs/heads/feat',
              destinationReference: 'refs/heads/main',
            },
          ],
        },
      }),
    });
    const vcs = createCodecommitVCS({ client });
    const pr = await vcs.getPR(REF);
    expect(pr.title).toBe('feat: x');
    expect(pr.body).toBe('body');
    expect(pr.author).toBe('jane');
    expect(pr.headSha).toBe('h1');
    expect(pr.baseSha).toBe('b1');
    expect(pr.draft).toBe(false);
    expect(pr.labels).toEqual([]);
    // CodeCommit does not expose commit messages on the PullRequest
    // payload; surface an empty array so the runner / wrapUntrusted
    // simply omit the <commits> child.
    expect(pr.commitMessages).toEqual([]);
    expect(client.send).toHaveBeenCalledWith(expect.any(GetPullRequestCommand));
  });

  it('throws when the API returns no PullRequest', async () => {
    const client = fakeClient({ GetPullRequestCommand: () => ({}) });
    const vcs = createCodecommitVCS({ client });
    await expect(() => vcs.getPR(REF)).rejects.toThrow(/not found/);
  });

  it('rejects non-codecommit refs', async () => {
    const client = fakeClient({});
    const vcs = createCodecommitVCS({ client });
    await expect(() =>
      vcs.getPR({ platform: 'github', owner: 'a', repo: 'b', number: 1 }),
    ).rejects.toThrow(/CodeCommit/);
  });
});

describe('createCodecommitVCS — getDiff', () => {
  it('walks paginated GetDifferences and maps change types', async () => {
    let page = 0;
    const client = fakeClient({
      GetPullRequestCommand: () => ({
        pullRequest: {
          pullRequestTargets: [{ sourceCommit: 'h1', destinationCommit: 'b1' }],
        },
      }),
      GetDifferencesCommand: () => {
        page += 1;
        if (page === 1) {
          return {
            differences: [
              { afterBlob: { path: 'a.ts' }, changeType: 'A' },
              { afterBlob: { path: 'b.ts' }, beforeBlob: { path: 'b.ts' }, changeType: 'M' },
            ],
            NextToken: 'next',
          };
        }
        return {
          differences: [{ beforeBlob: { path: 'c.ts' }, changeType: 'D' }],
        };
      },
    });
    const vcs = createCodecommitVCS({ client });
    const diff = await vcs.getDiff(REF);
    expect(diff.baseSha).toBe('b1');
    expect(diff.headSha).toBe('h1');
    expect(diff.files.map((f) => `${f.path}:${f.status}`)).toEqual([
      'a.ts:added',
      'b.ts:modified',
      'c.ts:removed',
    ]);
  });

  it('uses sinceSha for incremental diffs', async () => {
    const sendCalls: unknown[] = [];
    const client = {
      send: vi.fn(async (cmd: { constructor: { name: string }; input: unknown }) => {
        sendCalls.push(cmd);
        if (cmd.constructor.name === 'GetPullRequestCommand') {
          return {
            pullRequest: {
              pullRequestTargets: [{ sourceCommit: 'h1', destinationCommit: 'b1' }],
            },
          };
        }
        return { differences: [] };
      }),
    };
    const vcs = createCodecommitVCS({ client });
    await vcs.getDiff(REF, { sinceSha: 'h0' });
    const diffCmd = sendCalls.find(
      (c): c is { constructor: { name: string }; input: { beforeCommitSpecifier: string } } =>
        (c as { constructor: { name: string } }).constructor.name === 'GetDifferencesCommand',
    );
    expect(diffCmd?.input.beforeCommitSpecifier).toBe('h0');
  });
});

describe('createCodecommitVCS — getFile', () => {
  it('returns the file content as a Buffer', async () => {
    const bytes = new TextEncoder().encode('hello');
    const client = fakeClient({
      GetFileCommand: () => ({ fileContent: bytes }),
    });
    const vcs = createCodecommitVCS({ client });
    const buf = await vcs.getFile(REF, 'a.ts', 'h1');
    expect(buf.toString('utf8')).toBe('hello');
    expect(client.send).toHaveBeenCalledWith(expect.any(GetFileCommand));
  });

  it('returns an empty Buffer when no file content is returned', async () => {
    const client = fakeClient({
      GetFileCommand: () => ({}),
    });
    const vcs = createCodecommitVCS({ client });
    const buf = await vcs.getFile(REF, 'a.ts', 'h1');
    expect(buf.length).toBe(0);
  });

  it('refuses unsafe paths before issuing GetFileCommand', async () => {
    // Mirrors the GitHub adapter's path-guard behavior. The CodeCommit SDK
    // would otherwise happily echo `..` segments to the server.
    const client = fakeClient({
      GetFileCommand: () => ({ fileContent: new TextEncoder().encode('LEAKED') }),
    });
    const vcs = createCodecommitVCS({ client });
    for (const bad of ['/etc/passwd', '~/.aws/credentials', '../secrets.txt', 'a/../../etc/x']) {
      await expect(vcs.getFile(REF, bad, 'h1')).rejects.toThrow(/Refusing/);
    }
    await expect(vcs.getFile(REF, '', 'h1')).rejects.toThrow(/empty/);
    await expect(vcs.getFile(REF, 'a\0b', 'h1')).rejects.toThrow(/NUL/);
    expect(client.send).not.toHaveBeenCalled();
  });
});

describe('createCodecommitVCS — postReview', () => {
  it('posts a top-level summary then one comment per inline finding', async () => {
    const seen: Array<{ name: string; input: unknown }> = [];
    const client = {
      send: vi.fn(async (cmd: { constructor: { name: string }; input: unknown }) => {
        seen.push({ name: cmd.constructor.name, input: cmd.input });
        if (cmd.constructor.name === 'GetPullRequestCommand') {
          return {
            pullRequest: {
              pullRequestTargets: [{ sourceCommit: 'h1', destinationCommit: 'b1' }],
            },
          };
        }
        return { comment: { commentId: 'cid' } };
      }),
    };
    const vcs = createCodecommitVCS({ client });
    await vcs.postReview(REF, {
      summary: 'overall ok',
      comments: [
        {
          path: 'a.ts',
          line: 12,
          side: 'RIGHT',
          body: 'tighten this',
          fingerprint: 'fp1',
          severity: 'must_fix',
        },
        {
          path: 'b.ts',
          line: 3,
          side: 'LEFT',
          body: 'check the legacy form',
          fingerprint: 'fp2',
          severity: 'consider',
        },
      ],
      state: {
        schemaVersion: 1,
        lastReviewedSha: 'h1',
        baseSha: 'b1',
        reviewedAt: '2026-04-30T00:00:00Z',
        modelUsed: 'm',
        totalTokens: 0,
        totalCostUsd: 0,
        commentFingerprints: [],
      },
    });
    const posts = seen.filter((s) => s.name === 'PostCommentForPullRequestCommand');
    expect(posts).toHaveLength(3);
    const summaryPost = posts[0]?.input as { content: string; location?: unknown };
    expect(summaryPost.content).toBe('overall ok');
    expect(summaryPost.location).toBeUndefined();
    const inlineRight = posts[1]?.input as {
      location: { filePosition: number; relativeFileVersion: string };
    };
    expect(inlineRight.location.relativeFileVersion).toBe('AFTER');
    expect(inlineRight.location.filePosition).toBe(12);
    const inlineLeft = posts[2]?.input as {
      location: { relativeFileVersion: string };
    };
    expect(inlineLeft.location.relativeFileVersion).toBe('BEFORE');
  });
});

describe('createCodecommitVCS — postReview approvalState mapping (#74)', () => {
  const baseState: ReviewState = {
    schemaVersion: 1,
    lastReviewedSha: 'h1',
    baseSha: 'b1',
    reviewedAt: '2026-05-17T00:00:00Z',
    modelUsed: 'm',
    totalTokens: 0,
    totalCostUsd: 0,
    commentFingerprints: [],
  };

  function buildPayload(event: ReviewEvent | undefined): ReviewPayload {
    const base: ReviewPayload = {
      summary: 'ok',
      comments: [],
      state: baseState,
    };
    return event === undefined ? base : { ...base, event };
  }

  function buildClient() {
    return fakeClient({
      GetPullRequestCommand: () => ({
        pullRequest: {
          revisionId: 'rev-1',
          pullRequestTargets: [{ sourceCommit: 'h1', destinationCommit: 'b1' }],
        },
      }),
      PostCommentForPullRequestCommand: () => ({ comment: { commentId: 'cid' } }),
      UpdatePullRequestApprovalStateCommand: () => ({}),
    });
  }

  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("defaults to 'off' and never issues UpdatePullRequestApprovalStateCommand", async () => {
    const client = buildClient();
    const vcs = createCodecommitVCS({ client });
    await vcs.postReview(REF, buildPayload('REQUEST_CHANGES'));
    const approvalCalls = client.send.mock.calls.filter(
      ([cmd]) =>
        (cmd as { constructor: { name: string } }).constructor.name ===
        'UpdatePullRequestApprovalStateCommand',
    );
    expect(approvalCalls).toHaveLength(0);
  });

  it("'managed' + APPROVE sends UpdatePullRequestApprovalState(APPROVE)", async () => {
    const client = buildClient();
    const vcs = createCodecommitVCS({ client, approvalState: 'managed' });
    await vcs.postReview(REF, buildPayload('APPROVE'));
    const approvalCmd = client.send.mock.calls
      .map(([cmd]) => cmd as UpdatePullRequestApprovalStateCommand)
      .find((cmd) => cmd.constructor.name === 'UpdatePullRequestApprovalStateCommand');
    expect(approvalCmd).toBeDefined();
    expect(approvalCmd?.input).toEqual({
      pullRequestId: '7',
      revisionId: 'rev-1',
      approvalState: 'APPROVE',
    });
  });

  it("'managed' + REQUEST_CHANGES sends UpdatePullRequestApprovalState(REVOKE)", async () => {
    const client = buildClient();
    const vcs = createCodecommitVCS({ client, approvalState: 'managed' });
    await vcs.postReview(REF, buildPayload('REQUEST_CHANGES'));
    const approvalCmd = client.send.mock.calls
      .map(([cmd]) => cmd as UpdatePullRequestApprovalStateCommand)
      .find((cmd) => cmd.constructor.name === 'UpdatePullRequestApprovalStateCommand');
    expect(approvalCmd?.input).toEqual({
      pullRequestId: '7',
      revisionId: 'rev-1',
      approvalState: 'REVOKE',
    });
  });

  it("'managed' + COMMENT issues no approval-state call", async () => {
    const client = buildClient();
    const vcs = createCodecommitVCS({ client, approvalState: 'managed' });
    await vcs.postReview(REF, buildPayload('COMMENT'));
    const approvalCalls = client.send.mock.calls.filter(
      ([cmd]) =>
        (cmd as { constructor: { name: string } }).constructor.name ===
        'UpdatePullRequestApprovalStateCommand',
    );
    expect(approvalCalls).toHaveLength(0);
  });

  it("'managed' + missing event issues no approval-state call (back-compat)", async () => {
    const client = buildClient();
    const vcs = createCodecommitVCS({ client, approvalState: 'managed' });
    await vcs.postReview(REF, buildPayload(undefined));
    const approvalCalls = client.send.mock.calls.filter(
      ([cmd]) =>
        (cmd as { constructor: { name: string } }).constructor.name ===
        'UpdatePullRequestApprovalStateCommand',
    );
    expect(approvalCalls).toHaveLength(0);
  });

  it('warns and continues when the approval-state call throws (no approval rule)', async () => {
    const noRuleErr = Object.assign(new Error('No approval rule applies'), {
      name: 'ApprovalRuleDoesNotExistException',
    });
    const client = {
      send: vi.fn(async (cmd: { constructor: { name: string }; input: unknown }) => {
        if (cmd.constructor.name === 'GetPullRequestCommand') {
          return {
            pullRequest: {
              revisionId: 'rev-1',
              pullRequestTargets: [{ sourceCommit: 'h1', destinationCommit: 'b1' }],
            },
          };
        }
        if (cmd.constructor.name === 'UpdatePullRequestApprovalStateCommand') {
          throw noRuleErr;
        }
        return { comment: { commentId: 'cid' } };
      }),
    };
    const vcs = createCodecommitVCS({ client, approvalState: 'managed' });
    await expect(vcs.postReview(REF, buildPayload('APPROVE'))).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [msg] = warnSpy.mock.calls[0] ?? [];
    expect(String(msg)).toContain('ApprovalRuleDoesNotExistException');
    expect(String(msg)).toContain('UpdatePullRequestApprovalState');
  });

  it("'managed' but PullRequest has no revisionId logs a warn and skips the call", async () => {
    const client = fakeClient({
      GetPullRequestCommand: () => ({
        pullRequest: {
          // revisionId intentionally omitted
          pullRequestTargets: [{ sourceCommit: 'h1', destinationCommit: 'b1' }],
        },
      }),
      PostCommentForPullRequestCommand: () => ({ comment: { commentId: 'cid' } }),
    });
    const vcs = createCodecommitVCS({ client, approvalState: 'managed' });
    await vcs.postReview(REF, buildPayload('APPROVE'));
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const approvalCalls = client.send.mock.calls.filter(
      ([cmd]) =>
        (cmd as { constructor: { name: string } }).constructor.name ===
        'UpdatePullRequestApprovalStateCommand',
    );
    expect(approvalCalls).toHaveLength(0);
  });
});

describe('createCodecommitVCS — postSummary', () => {
  it('returns the commentId from the API response', async () => {
    const client = fakeClient({
      GetPullRequestCommand: () => ({
        pullRequest: {
          pullRequestTargets: [{ sourceCommit: 'h1', destinationCommit: 'b1' }],
        },
      }),
      PostCommentForPullRequestCommand: () => ({ comment: { commentId: 'c-99' } }),
    });
    const vcs = createCodecommitVCS({ client });
    const out = await vcs.postSummary(REF, 'hello');
    expect(out.commentId).toBe('c-99');
    expect(client.send).toHaveBeenCalledWith(expect.any(PostCommentForPullRequestCommand));
  });
});

describe('createCodecommitVCS — getExistingComments', () => {
  it('flattens grouped comments and pages through nextToken', async () => {
    let page = 0;
    const client = fakeClient({
      GetCommentsForPullRequestCommand: () => {
        page += 1;
        if (page === 1) {
          return {
            commentsForPullRequestData: [
              {
                location: { filePath: 'a.ts', filePosition: 12, relativeFileVersion: 'AFTER' },
                comments: [
                  {
                    commentId: 'c1',
                    content: 'hello',
                    authorArn: 'arn:aws:iam::1:user/sara',
                    creationDate: new Date('2026-04-30T00:00:00Z'),
                  },
                ],
              },
            ],
            nextToken: 'next',
          };
        }
        return {
          commentsForPullRequestData: [
            {
              comments: [
                {
                  commentId: 'c2',
                  content: 'thread',
                  creationDate: new Date('2026-04-30T01:00:00Z'),
                },
              ],
            },
          ],
        };
      },
    });
    const vcs = createCodecommitVCS({ client });
    const comments = await vcs.getExistingComments(REF);
    expect(comments).toHaveLength(2);
    expect(comments[0]?.id).toBe('c1');
    expect(comments[0]?.path).toBe('a.ts');
    expect(comments[0]?.line).toBe(12);
    expect(comments[0]?.side).toBe('RIGHT');
    expect(comments[0]?.author).toBe('sara');
    expect(comments[1]?.id).toBe('c2');
    expect(comments[1]?.path).toBeNull();
    expect(comments[1]?.author).toBe('unknown');
    expect(client.send).toHaveBeenCalledWith(expect.any(GetCommentsForPullRequestCommand));
  });
});

describe('createCodecommitVCS — state methods', () => {
  it('always returns null from getStateComment (Postgres-only state)', async () => {
    const vcs = createCodecommitVCS({ client: fakeClient({}) });
    expect(await vcs.getStateComment(REF)).toBeNull();
  });

  it('no-ops upsertStateComment', async () => {
    const vcs = createCodecommitVCS({ client: fakeClient({}) });
    const state: ReviewState = {
      schemaVersion: 1,
      lastReviewedSha: 'h',
      baseSha: 'b',
      reviewedAt: '2026-04-30T00:00:00Z',
      modelUsed: 'm',
      totalTokens: 0,
      totalCostUsd: 0,
      commentFingerprints: [],
    };
    await expect(vcs.upsertStateComment(REF, state)).resolves.toBeUndefined();
  });
});

describe('createCodecommitVCS — cloneRepo', () => {
  it('throws to surface that the adapter does not implement clone', async () => {
    const vcs = createCodecommitVCS({ client: fakeClient({}) });
    await expect(() =>
      vcs.cloneRepo(REF, '/tmp/x', { depth: 1, filter: 'blob:none' }),
    ).rejects.toThrow(/not supported/);
  });
});

describe('createCodecommitVCS — exposed metadata', () => {
  it('reports the platform string', () => {
    const vcs = createCodecommitVCS({ client: fakeClient({}) });
    expect(vcs.platform).toBe('codecommit');
  });

  it('declares CodeCommit-specific capabilities (no clone, postgres-only state, codecommit approval, no commit msgs)', () => {
    const vcs = createCodecommitVCS({ client: fakeClient({}) });
    expect(vcs.capabilities).toEqual({
      clone: false,
      stateComment: 'postgres-only',
      approvalEvent: 'codecommit',
      commitMessages: false,
    });
  });
});
