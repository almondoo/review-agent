import {
  GetCommentsForPullRequestCommand,
  GetFileCommand,
  GetPullRequestCommand,
  ListPullRequestsCommand,
  PostCommentForPullRequestCommand,
  type UpdatePullRequestApprovalStateCommand,
} from '@aws-sdk/client-codecommit';
import type { PRRef, ReviewEvent, ReviewPayload, ReviewState } from '@review-agent/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createCodecommitVCS,
  createDefaultCodeCommitClient,
  listCodeCommitCommentsForPullRequest,
  listCodeCommitPullRequestIds,
} from './adapter.js';

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

describe('createCodecommitVCS — capabilities', () => {
  it('declares committableSuggestions=false (informational only, no hunk check)', () => {
    const client = fakeClient({});
    const vcs = createCodecommitVCS({ client });
    expect(vcs.capabilities.committableSuggestions).toBe(false);
    expect(vcs.capabilities.conversationReply).toBe(false);
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

  it('appends the hidden fingerprint marker to each inline comment body (#96)', async () => {
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
      summary: 'two findings',
      comments: [
        {
          path: 'a.ts',
          line: 1,
          side: 'RIGHT',
          body: 'first finding',
          fingerprint: 'abcdef0123456789',
          severity: 'minor',
        },
        {
          path: 'b.ts',
          line: 5,
          side: 'RIGHT',
          body: 'second finding\nwith two lines',
          fingerprint: 'fedcba9876543210',
          severity: 'critical',
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
        commentFingerprints: ['abcdef0123456789', 'fedcba9876543210'],
      },
    });
    const inlinePosts = seen.filter((s) => s.name === 'PostCommentForPullRequestCommand').slice(1); // first post is the summary
    expect((inlinePosts[0]?.input as { content: string }).content).toBe(
      'first finding\n\n<!-- fingerprint:abcdef0123456789 -->',
    );
    expect((inlinePosts[1]?.input as { content: string }).content).toBe(
      'second finding\nwith two lines\n\n<!-- fingerprint:fedcba9876543210 -->',
    );
  });

  it('renders suggestion as informational fenced block when suggestion is present (#152)', async () => {
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
      summary: 'suggestion test',
      comments: [
        {
          path: 'a.ts',
          line: 5,
          side: 'RIGHT',
          body: 'consider extracting this',
          fingerprint: 'aabbccddeeff0011',
          severity: 'minor',
          suggestion: 'const helper = () => { ... };',
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
    const inlinePosts = seen.filter((s) => s.name === 'PostCommentForPullRequestCommand').slice(1); // skip summary post
    const content = (inlinePosts[0]?.input as { content: string }).content;
    // Must contain the original body
    expect(content).toContain('consider extracting this');
    // Must contain the informational block (not GitHub's ```suggestion syntax)
    expect(content).toContain('**Suggested fix:**');
    expect(content).toContain('```\nconst helper = () => { ... };\n```');
    // Must NOT use GitHub's committable suggestion syntax
    expect(content).not.toContain('```suggestion');
    // Fingerprint marker must be present
    expect(content).toContain('<!-- fingerprint:aabbccddeeff0011 -->');
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
    // The SDK error `message` here mirrors a real AWS AccessDenied
    // body and embeds an assumed-role ARN with an account id. The
    // adapter must NOT include this string in its warn line — see
    // SEC-6 in the audit notes.
    const leakyMessage =
      'User: arn:aws:sts::123456789012:assumed-role/review-agent-worker/abc ' +
      'is not authorized to perform: codecommit:UpdatePullRequestApprovalState';
    const noRuleErr = Object.assign(new Error(leakyMessage), {
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
    const line = String(msg);
    // The error class name and the API name should still be present
    // for operator diagnosis.
    expect(line).toContain('ApprovalRuleDoesNotExistException');
    expect(line).toContain('UpdatePullRequestApprovalState');
    // SEC-6: the warn line must not leak the role ARN, assumed-role
    // path, or the 12-digit account id carried by `err.message`.
    expect(line).not.toContain('arn:aws:');
    expect(line).not.toContain('assumed-role');
    expect(line).not.toMatch(/\d{12}/);
    expect(line).not.toContain(leakyMessage);
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

describe('listCodeCommitPullRequestIds (#110 hardening)', () => {
  it('rejects PR id strings containing non-digit suffixes (strict regex)', async () => {
    // `Number.parseInt('42-archived', 10)` would coerce to `42` and
    // silently re-key against an unrelated PR. The strict `/^\d+$/`
    // guard rejects these.
    const client = fakeClient({
      ListPullRequestsCommand: () => ({
        pullRequestIds: ['10', '42-archived', '11', 'oops', '12'],
      }),
    });
    const ids = await listCodeCommitPullRequestIds(client, {
      repositoryName: 'demo-repo',
      pullRequestStatus: 'OPEN',
    });
    expect(ids).toEqual([10, 11, 12]);
    expect(client.send).toHaveBeenCalledWith(expect.any(ListPullRequestsCommand));
  });
});

describe('listCodeCommitCommentsForPullRequest (#110 hardening)', () => {
  it('preserves the authorArn from the SDK Comment shape', async () => {
    const client = fakeClient({
      GetCommentsForPullRequestCommand: () => ({
        commentsForPullRequestData: [
          {
            comments: [
              {
                commentId: 'k1',
                content: 'bot-output',
                authorArn: 'arn:aws:iam::123:role/review-agent-bot',
                creationDate: new Date('2026-05-10T00:00:00Z'),
              },
              {
                commentId: 'k2',
                content: '/feedback reject',
                inReplyTo: 'k1',
                authorArn: 'arn:aws:iam::123:user/alice',
                creationDate: new Date('2026-05-11T00:00:00Z'),
              },
            ],
          },
        ],
      }),
    });
    const out = await listCodeCommitCommentsForPullRequest(client, { pullRequestId: '7' });
    expect(out).toHaveLength(2);
    expect(out[0]?.authorArn).toBe('arn:aws:iam::123:role/review-agent-bot');
    expect(out[1]?.authorArn).toBe('arn:aws:iam::123:user/alice');
    expect(out[1]?.inReplyTo).toBe('k1');
  });
});

describe('createDefaultCodeCommitClient (#110)', () => {
  it('returns an object with a send method when called with no config', () => {
    const client = createDefaultCodeCommitClient();
    expect(typeof client.send).toBe('function');
  });

  it('returns an object with a send method when called with a config override', () => {
    const client = createDefaultCodeCommitClient({ region: 'us-east-1' });
    expect(typeof client.send).toBe('function');
  });
});

describe('listCodeCommitCommentsForPullRequest — creationDate string branch (#110)', () => {
  it('converts a string creationDate to a Date instance', async () => {
    const client = fakeClient({
      GetCommentsForPullRequestCommand: () => ({
        commentsForPullRequestData: [
          {
            comments: [
              {
                commentId: 'str-date-1',
                content: 'raw',
                creationDate: '2026-05-01T00:00:00Z',
              },
            ],
          },
        ],
      }),
    });
    const out = await listCodeCommitCommentsForPullRequest(client, { pullRequestId: '9' });
    expect(out).toHaveLength(1);
    expect(out[0]?.creationDate).toBeInstanceOf(Date);
    expect(out[0]?.creationDate?.toISOString()).toBe('2026-05-01T00:00:00.000Z');
  });
});

describe('createCodecommitVCS — exposed metadata', () => {
  it('reports the platform string', () => {
    const vcs = createCodecommitVCS({ client: fakeClient({}) });
    expect(vcs.platform).toBe('codecommit');
  });

  it('declares CodeCommit-specific capabilities (no clone, postgres-only state, codecommit approval, no commit msgs, no conversationReply, no committableSuggestions)', () => {
    const vcs = createCodecommitVCS({ client: fakeClient({}) });
    expect(vcs.capabilities).toEqual({
      clone: false,
      stateComment: 'postgres-only',
      approvalEvent: 'codecommit',
      commitMessages: false,
      conversationReply: false,
      committableSuggestions: false,
    });
  });
});

// ---------------------------------------------------------------------------
// Stage C: branch-coverage hardening.
// The following groups exercise paths that exist in the helpers but are only
// reached on pagination tokens / unknown enum values / fallback defaults.
// ---------------------------------------------------------------------------

describe('listCodeCommitCommentsForPullRequest — pagination', () => {
  it('concatenates results across nextToken pages', async () => {
    // Page 1 returns one comment + a nextToken; page 2 returns the second
    // comment with no token, terminating the loop. The flattened result
    // must preserve insertion order across the page boundary.
    let page = 0;
    const client = fakeClient({
      GetCommentsForPullRequestCommand: () => {
        page += 1;
        if (page === 1) {
          return {
            commentsForPullRequestData: [
              {
                comments: [
                  {
                    commentId: 'p1-c1',
                    content: 'first page',
                    creationDate: new Date('2026-05-15T00:00:00Z'),
                  },
                ],
              },
            ],
            nextToken: 'tok2',
          };
        }
        return {
          commentsForPullRequestData: [
            {
              comments: [
                {
                  commentId: 'p2-c1',
                  content: 'second page',
                  creationDate: new Date('2026-05-16T00:00:00Z'),
                },
              ],
            },
          ],
        };
      },
    });
    const out = await listCodeCommitCommentsForPullRequest(client, { pullRequestId: '7' });
    expect(out.map((c) => c.commentId)).toEqual(['p1-c1', 'p2-c1']);
    expect(client.send).toHaveBeenCalledTimes(2);
  });

  it('honors the injected sleep between paged calls when delayMs > 0', async () => {
    // The `sleep` test seam is invoked only when (nextToken && delayMs > 0).
    // We pass a delayMs and a stub sleep to pin that branch.
    let page = 0;
    const client = fakeClient({
      GetCommentsForPullRequestCommand: () => {
        page += 1;
        if (page === 1) {
          return {
            commentsForPullRequestData: [{ comments: [{ commentId: 'a', content: '' }] }],
            nextToken: 'next',
          };
        }
        return {
          commentsForPullRequestData: [{ comments: [{ commentId: 'b', content: '' }] }],
        };
      },
    });
    const sleep = vi.fn(async () => undefined);
    const out = await listCodeCommitCommentsForPullRequest(client, {
      pullRequestId: '9',
      delayMs: 25,
      sleep,
    });
    expect(out).toHaveLength(2);
    // Sleep is invoked once: after page 1's response yielded a nextToken, but
    // not after page 2 (no token). Pin the call count + the forwarded delay.
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(25);
  });

  it('skips raw comments missing a commentId (defensive against malformed SDK rows)', async () => {
    // The helper's `if (!c.commentId) continue` guard is otherwise dead in the
    // happy path because every test fixture supplies an id. A real SDK error
    // body / malformed mock could feed in `commentId: undefined` and we'd
    // otherwise materialize a zero-id row.
    const client = fakeClient({
      GetCommentsForPullRequestCommand: () => ({
        commentsForPullRequestData: [
          {
            comments: [
              { commentId: undefined, content: 'will be skipped' },
              { commentId: 'kept', content: 'will be kept' },
            ],
          },
        ],
      }),
    });
    const out = await listCodeCommitCommentsForPullRequest(client, { pullRequestId: '5' });
    expect(out.map((c) => c.commentId)).toEqual(['kept']);
  });
});

describe('listCodeCommitPullRequestIds — pagination + edge cases', () => {
  it('concatenates ids across nextToken pages within a single status pass', async () => {
    // Page 1 returns two ids + a nextToken; page 2 returns the third id and
    // terminates. Status defaults to 'ALL' so the helper would also walk
    // CLOSED — we pin the call path by checking the union.
    let openPage = 0;
    let closedPage = 0;
    const client = fakeClient({
      ListPullRequestsCommand: (input) => {
        const status = (input as { pullRequestStatus: string }).pullRequestStatus;
        if (status === 'OPEN') {
          openPage += 1;
          if (openPage === 1) {
            return { pullRequestIds: ['10', '11'], nextToken: 'open-tok2' };
          }
          return { pullRequestIds: ['12'] };
        }
        closedPage += 1;
        return { pullRequestIds: ['20'] };
      },
    });
    const ids = await listCodeCommitPullRequestIds(client, {
      repositoryName: 'demo-repo',
      // explicit OPEN to keep this focused on pagination within one status
      pullRequestStatus: 'OPEN',
    });
    expect(ids).toEqual([10, 11, 12]);
    expect(client.send).toHaveBeenCalledTimes(2);
    expect(closedPage).toBe(0); // We did not opt into ALL.
  });

  it('returns an empty array when the API yields no ids at all', async () => {
    // Empty `pullRequestIds: []` from a fresh repo must short-circuit to
    // `[]` rather than throwing or returning an undefined-shaped value.
    const client = fakeClient({
      ListPullRequestsCommand: () => ({ pullRequestIds: [] }),
    });
    const ids = await listCodeCommitPullRequestIds(client, {
      repositoryName: 'empty-repo',
      pullRequestStatus: 'OPEN',
    });
    expect(ids).toEqual([]);
  });

  it("dedupes ids that appear under both 'OPEN' and 'CLOSED' on the default 'ALL' walk", async () => {
    // Defensive guard against a stub or buggy SDK that returns the same id
    // under multiple status filters; the helper's `seen` Set must collapse.
    const client = fakeClient({
      ListPullRequestsCommand: (input) => {
        const status = (input as { pullRequestStatus: string }).pullRequestStatus;
        if (status === 'OPEN') return { pullRequestIds: ['1', '2'] };
        return { pullRequestIds: ['2', '3'] };
      },
    });
    const ids = await listCodeCommitPullRequestIds(client, {
      repositoryName: 'demo-repo',
      // default ('ALL') — walks both passes
    });
    expect(ids).toEqual([1, 2, 3]);
  });
});

describe('createCodecommitVCS — getDiff unknown changeType fallback', () => {
  it("maps any unrecognized changeType to 'modified' (forward-compat default)", async () => {
    // The CodeCommit GetDifferences API only documents A/M/D, but a future
    // change-type letter or a renamed file (which CodeCommit does NOT report
    // distinctly today) would otherwise crash the type guard. Pin the
    // default-to-modified branch in `mapDiffStatus`.
    const client = fakeClient({
      GetPullRequestCommand: () => ({
        pullRequest: {
          pullRequestTargets: [{ sourceCommit: 'h1', destinationCommit: 'b1' }],
        },
      }),
      GetDifferencesCommand: () => ({
        differences: [
          { afterBlob: { path: 'unknown.ts' }, changeType: 'STRANGE' },
          // Also exercise the `!changeType` shortcut explicitly: a row
          // missing `changeType` entirely.
          { afterBlob: { path: 'no-type.ts' } },
        ],
      }),
    });
    const vcs = createCodecommitVCS({ client });
    const diff = await vcs.getDiff(REF);
    expect(diff.files.map((f) => `${f.path}:${f.status}`)).toEqual([
      'unknown.ts:modified',
      'no-type.ts:modified',
    ]);
  });
});

describe('createCodecommitVCS — postReview empty comments', () => {
  it('posts only the summary when the review has zero inline findings', async () => {
    // The for-loop body never executes; we exercise the empty-iteration
    // branch and pin that we issue exactly one PostCommentForPullRequest
    // call (the summary) and no inline comments.
    const seen: string[] = [];
    const client = {
      send: vi.fn(async (cmd: { constructor: { name: string }; input: unknown }) => {
        seen.push(cmd.constructor.name);
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
      summary: 'looks good — no inline comments',
      comments: [],
      state: {
        schemaVersion: 1,
        lastReviewedSha: 'h1',
        baseSha: 'b1',
        reviewedAt: '2026-05-22T00:00:00Z',
        modelUsed: 'm',
        totalTokens: 0,
        totalCostUsd: 0,
        commentFingerprints: [],
      },
    });
    const posts = seen.filter((n) => n === 'PostCommentForPullRequestCommand');
    expect(posts).toHaveLength(1); // summary only, no inline calls
  });

  it('skips the summary call when summary is the empty string', async () => {
    // `if (review.summary)` falsy on '' — no summary post is made, and the
    // empty comments array also means no inline calls. End state: no
    // PostCommentForPullRequestCommand calls at all.
    const seen: string[] = [];
    const client = {
      send: vi.fn(async (cmd: { constructor: { name: string }; input: unknown }) => {
        seen.push(cmd.constructor.name);
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
      summary: '',
      comments: [],
      state: {
        schemaVersion: 1,
        lastReviewedSha: 'h1',
        baseSha: 'b1',
        reviewedAt: '2026-05-22T00:00:00Z',
        modelUsed: 'm',
        totalTokens: 0,
        totalCostUsd: 0,
        commentFingerprints: [],
      },
    });
    expect(seen.filter((n) => n === 'PostCommentForPullRequestCommand')).toHaveLength(0);
  });
});

describe('createCodecommitVCS — getPR fallbacks for missing PullRequest fields', () => {
  it('substitutes safe defaults when title/description/author/dates are absent', async () => {
    // Every `?? ''` / `?? 'unknown'` / `?? new Date(0).toISOString()` fallback
    // in toPR has a paired covered branch; this case forces the un-covered
    // sides of those coalesces.
    const client = fakeClient({
      GetPullRequestCommand: () => ({
        pullRequest: {
          pullRequestId: '7',
          // title, description, authorArn, creationDate, lastActivityDate
          // all intentionally omitted to drive the `?? <default>` branches.
          pullRequestTargets: [
            {
              repositoryName: 'demo-repo',
              // also omit sourceCommit/destinationCommit/reference fields
              // so the `target?.X ?? ''` fallbacks are exercised.
            },
          ],
        },
      }),
    });
    const vcs = createCodecommitVCS({ client });
    const pr = await vcs.getPR(REF);
    expect(pr.title).toBe('');
    expect(pr.body).toBe('');
    expect(pr.author).toBe('unknown'); // parseAuthor undefined → 'unknown'
    expect(pr.baseSha).toBe('');
    expect(pr.headSha).toBe('');
    expect(pr.baseRef).toBe('');
    expect(pr.headRef).toBe('');
    expect(pr.createdAt).toBe(new Date(0).toISOString());
    expect(pr.updatedAt).toBe(new Date(0).toISOString());
  });

  it('handles a PullRequest with no pullRequestTargets array (target?. fallback)', async () => {
    // `pr.pullRequestTargets?.[0]` is `undefined` when the array is missing
    // entirely; every `target?.X ?? ''` falls through to the default. This
    // pins the optional-chaining branch separately from the inner `??`.
    const client = fakeClient({
      GetPullRequestCommand: () => ({
        pullRequest: {
          pullRequestId: '7',
          // pullRequestTargets intentionally omitted
        },
      }),
    });
    const vcs = createCodecommitVCS({ client });
    const pr = await vcs.getPR(REF);
    expect(pr.baseSha).toBe('');
    expect(pr.headSha).toBe('');
  });
});

describe('createCodecommitVCS — getExistingComments empty result', () => {
  it('returns [] when the SDK yields no commentsForPullRequestData', async () => {
    // The `?? []` defaults on the response itself and on the inner
    // `group.comments` array are only one nested-coalesce away from the
    // top-level happy path; pin them with an empty fixture.
    const client = fakeClient({
      GetCommentsForPullRequestCommand: () => ({}),
    });
    const vcs = createCodecommitVCS({ client });
    const out = await vcs.getExistingComments(REF);
    expect(out).toEqual([]);
  });
});

describe('listCodeCommitCommentsForPullRequest — defensive field defaults', () => {
  it('substitutes empty string when comment content is absent', async () => {
    // `c.content ?? ''` branch. A real SDK response with a deleted comment
    // may have `content: undefined`; we materialize the empty string rather
    // than `undefined`.
    const client = fakeClient({
      GetCommentsForPullRequestCommand: () => ({
        commentsForPullRequestData: [
          {
            comments: [
              {
                commentId: 'no-content',
                // content omitted
              },
            ],
          },
        ],
      }),
    });
    const out = await listCodeCommitCommentsForPullRequest(client, { pullRequestId: '1' });
    expect(out).toHaveLength(1);
    expect(out[0]?.content).toBe('');
  });

  it('emits no creationDate when the SDK row has neither Date nor string', async () => {
    // The `else: undefined` branch of the creationDate normalize. The
    // resulting CodeCommitRawComment must omit `creationDate` entirely
    // (the spread `...(creationDate !== undefined ? {} : {})` is false).
    const client = fakeClient({
      GetCommentsForPullRequestCommand: () => ({
        commentsForPullRequestData: [
          {
            comments: [
              {
                commentId: 'no-date',
                content: 'x',
                // creationDate intentionally missing
              },
            ],
          },
        ],
      }),
    });
    const out = await listCodeCommitCommentsForPullRequest(client, { pullRequestId: '2' });
    expect(out).toHaveLength(1);
    expect(out[0]?.creationDate).toBeUndefined();
    expect('creationDate' in (out[0] ?? {})).toBe(false);
  });
});

describe('listCodeCommitPullRequestIds — missing pullRequestIds field', () => {
  it('treats a response with no pullRequestIds key as zero ids', async () => {
    // `resp.pullRequestIds ?? []` — the `??` defaults to the empty array
    // when the SDK response carries no key at all (vs an explicit `[]`).
    const client = fakeClient({
      ListPullRequestsCommand: () => ({}),
    });
    const ids = await listCodeCommitPullRequestIds(client, {
      repositoryName: 'repo',
      pullRequestStatus: 'OPEN',
    });
    expect(ids).toEqual([]);
  });
});

describe('listCodeCommitCommentsForPullRequest — empty/missing groups', () => {
  it('returns [] when commentsForPullRequestData is omitted entirely', async () => {
    // The outer `?? []` on `resp.commentsForPullRequestData` — distinct
    // branch from the inner per-group `group.comments ?? []` default.
    const client = fakeClient({
      GetCommentsForPullRequestCommand: () => ({}),
    });
    const out = await listCodeCommitCommentsForPullRequest(client, { pullRequestId: '0' });
    expect(out).toEqual([]);
  });

  it('skips a group whose `comments` field is missing', async () => {
    // The inner `?? []` on `group.comments`. A group with `location` but
    // no `comments` is valid per the SDK shape (e.g. a stub or an empty
    // discussion thread root).
    const client = fakeClient({
      GetCommentsForPullRequestCommand: () => ({
        commentsForPullRequestData: [
          { location: { filePath: 'a.ts' } /* comments omitted */ },
          { comments: [{ commentId: 'still-emitted', content: 'x' }] },
        ],
      }),
    });
    const out = await listCodeCommitCommentsForPullRequest(client, { pullRequestId: '0' });
    expect(out.map((c) => c.commentId)).toEqual(['still-emitted']);
  });
});

describe('createCodecommitVCS — getExistingComments preserves inReplyTo and date fallback', () => {
  it("emits inReplyTo when set and falls back to epoch on missing creationDate (toExistingComment's coalesces)", async () => {
    // Branches in toExistingComment we have not yet hit from getExistingComments():
    //   - `inReplyTo !== undefined ? { inReplyTo } : {}` truthy side.
    //   - `c.creationDate?.toISOString() ?? new Date(0).toISOString()` fallback side.
    //   - `c.content ?? ''` undefined side.
    // One fixture exercises all three; the second comment exercises the
    // opposite (no inReplyTo + a real creationDate) so the union is hit.
    const client = fakeClient({
      GetCommentsForPullRequestCommand: () => ({
        commentsForPullRequestData: [
          {
            location: { filePath: 'x.ts', filePosition: 1, relativeFileVersion: 'AFTER' },
            comments: [
              {
                commentId: 'reply-1',
                // content omitted → body should be ''
                // creationDate omitted → createdAt should fall back to epoch
                inReplyTo: 'parent-1',
                authorArn: 'arn:aws:iam::1:user/replier',
              },
            ],
          },
        ],
      }),
    });
    const vcs = createCodecommitVCS({ client });
    const out = await vcs.getExistingComments(REF);
    expect(out).toHaveLength(1);
    expect(out[0]?.inReplyTo).toBe('parent-1');
    expect(out[0]?.body).toBe('');
    expect(out[0]?.createdAt).toBe(new Date(0).toISOString());
  });
});

describe('listCodeCommitCommentsForPullRequest — default sleep wiring', () => {
  it('completes a multi-page walk with delayMs > 0 and the default real-timer sleep', async () => {
    // The `opts.sleep ?? (default)` branch — when the caller passes delayMs
    // but no sleep stub, the helper builds a real setTimeout-backed sleep.
    // We pin that the helper completes (and yields the concatenated rows)
    // with the production sleep impl on a very small delay so the test
    // still finishes within Vitest's default timeout.
    let page = 0;
    const client = fakeClient({
      GetCommentsForPullRequestCommand: () => {
        page += 1;
        if (page === 1) {
          return {
            commentsForPullRequestData: [{ comments: [{ commentId: 'pg1', content: '' }] }],
            nextToken: 'next',
          };
        }
        return {
          commentsForPullRequestData: [{ comments: [{ commentId: 'pg2', content: '' }] }],
        };
      },
    });
    const out = await listCodeCommitCommentsForPullRequest(client, {
      pullRequestId: '11',
      delayMs: 1,
      // sleep intentionally omitted → exercises the default `?? setTimeout` arm
    });
    expect(out.map((c) => c.commentId)).toEqual(['pg1', 'pg2']);
  });
});
