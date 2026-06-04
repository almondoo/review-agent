import type { DbClient } from '@review-agent/db';
import type { Context } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { _resetMetricsForTest } from '../metrics.js';
import { handleWebhook, recordFeedbackCommandOutcome } from './webhook.js';

// ---------------------------------------------------------------------------
// Module-level mock for @review-agent/db
//
// withTenant is replaced with a thin wrapper that calls fn(tx) where tx is
// the return value of db.transaction (i.e. the same tx the fakeDb exposes).
// This lets us assert on the insert/update/delete calls captured by the fake
// db without a live Postgres connection.
// ---------------------------------------------------------------------------
vi.mock('@review-agent/db', async () => {
  const actual = await vi.importActual<typeof import('@review-agent/db')>('@review-agent/db');
  return {
    ...actual,
    withTenant: async (
      db: { transaction: (fn: (tx: unknown) => Promise<unknown>) => Promise<unknown> },
      _installationId: unknown,
      fn: (tx: unknown) => Promise<unknown>,
    ) => db.transaction(fn),
  };
});

// ---------------------------------------------------------------------------
// Fake DbClient whose query-builder methods are vi.fn() spies.
// The transaction callback receives the same `tx` spy object so callers
// that call `tx.insert(...)` are captured.
// ---------------------------------------------------------------------------
function makeDb() {
  const insertResult = { onConflictDoUpdate: vi.fn().mockResolvedValue([]) };
  const updateResult = { set: vi.fn() };
  const updateSetResult = { where: vi.fn().mockResolvedValue([]) };
  updateResult.set.mockReturnValue(updateSetResult);

  const deleteResult = { where: vi.fn().mockResolvedValue([]) };

  const tx = {
    insert: vi.fn().mockReturnValue({ values: vi.fn().mockReturnValue(insertResult) }),
    update: vi.fn().mockReturnValue(updateResult),
    delete: vi.fn().mockReturnValue(deleteResult),
    execute: vi.fn().mockResolvedValue([{ tenant: '99' }]),
  };

  const db = {
    transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(tx)),
  } as unknown as DbClient;

  return { db, tx, insertResult, updateResult, updateSetResult, deleteResult };
}

afterEach(() => {
  _resetMetricsForTest();
});

const ctx = {} as unknown as Context;

function makeQueue() {
  const enqueue = vi.fn().mockResolvedValue({ messageId: 'm-1' });
  return {
    queue: { enqueue, dequeue: vi.fn() },
    enqueue,
  };
}

const baseRepo = {
  installation: { id: 11 },
  repository: { owner: { login: 'o' }, name: 'r' },
};

describe('handleWebhook', () => {
  it('ignores ping', async () => {
    const { queue, enqueue } = makeQueue();
    const r = await handleWebhook(ctx, 'ping', {}, { queue });
    expect(r.kind).toBe('noop');
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('acknowledges installation events without enqueueing', async () => {
    const { queue, enqueue } = makeQueue();
    const r = await handleWebhook(ctx, 'installation', {}, { queue });
    expect(r.kind).toBe('noop');
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('enqueues pull_request.opened', async () => {
    const { queue, enqueue } = makeQueue();
    const r = await handleWebhook(
      ctx,
      'pull_request',
      {
        action: 'opened',
        ...baseRepo,
        pull_request: { number: 7, draft: false, head: { sha: 'abc1234' } },
      },
      { queue, now: () => new Date('2026-04-30T00:00:00Z') },
    );
    expect(r).toEqual({ kind: 'enqueued', messageId: 'm-1' });
    expect(enqueue).toHaveBeenCalledOnce();
    const call = enqueue.mock.calls[0]?.[0];
    expect(call.triggeredBy).toBe('pull_request.opened');
    expect(call.prRef).toMatchObject({ owner: 'o', repo: 'r', number: 7, headSha: 'abc1234' });
  });

  it('ignores draft PRs', async () => {
    const { queue, enqueue } = makeQueue();
    const r = await handleWebhook(
      ctx,
      'pull_request',
      { action: 'opened', ...baseRepo, pull_request: { number: 7, draft: true } },
      { queue },
    );
    expect(r.kind).toBe('ignored');
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('ignores pull_request.closed', async () => {
    const { queue, enqueue } = makeQueue();
    const r = await handleWebhook(
      ctx,
      'pull_request',
      { action: 'closed', ...baseRepo, pull_request: { number: 7 } },
      { queue },
    );
    expect(r.kind).toBe('ignored');
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('ignores pull_request with no action (undefined action field)', async () => {
    const { queue, enqueue } = makeQueue();
    const r = await handleWebhook(
      ctx,
      'pull_request',
      { ...baseRepo, pull_request: { number: 7 } },
      { queue },
    );
    expect(r.kind).toBe('ignored');
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('ignores issue_comment when not on a PR', async () => {
    const { queue, enqueue } = makeQueue();
    const r = await handleWebhook(
      ctx,
      'issue_comment',
      { ...baseRepo, comment: { body: '@review-agent review' }, issue: { number: 5 } },
      { queue },
    );
    expect(r.kind).toBe('ignored');
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('enqueues @review-agent review command when authorized', async () => {
    const { queue, enqueue } = makeQueue();
    const checkAuthz = vi.fn().mockResolvedValue({ allowed: true });
    const r = await handleWebhook(
      ctx,
      'issue_comment',
      {
        ...baseRepo,
        sender: { login: 'alice' },
        comment: { body: 'thanks! @review-agent review', user: { login: 'alice' } },
        issue: { number: 9, pull_request: {} },
      },
      { queue, checkAuthz },
    );
    expect(r.kind).toBe('enqueued');
    expect(enqueue).toHaveBeenCalledOnce();
    const call = enqueue.mock.calls[0]?.[0];
    expect(call.triggeredBy).toBe('comment.command');
    expect(call.prRef.number).toBe(9);
  });

  it('treats unknown command as noop', async () => {
    const { queue, enqueue } = makeQueue();
    const r = await handleWebhook(
      ctx,
      'issue_comment',
      {
        ...baseRepo,
        comment: { body: '@review-agent help' },
        issue: { number: 9, pull_request: {} },
      },
      { queue },
    );
    expect(r.kind).toBe('noop');
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('command parsing is case-insensitive', async () => {
    const { queue, enqueue } = makeQueue();
    const checkAuthz = vi.fn().mockResolvedValue({ allowed: true });
    const r = await handleWebhook(
      ctx,
      'issue_comment',
      {
        ...baseRepo,
        sender: { login: 'alice' },
        comment: { body: '@ReView-AGent REVIEW', user: { login: 'alice' } },
        issue: { number: 9, pull_request: {} },
      },
      { queue, checkAuthz },
    );
    expect(r.kind).toBe('enqueued');
    expect(enqueue).toHaveBeenCalledOnce();
  });

  it('rejects malformed payload missing repo', async () => {
    const { queue, enqueue } = makeQueue();
    const r = await handleWebhook(
      ctx,
      'pull_request',
      { action: 'opened', pull_request: { number: 1 } },
      { queue },
    );
    expect(r.kind).toBe('ignored');
    expect(enqueue).not.toHaveBeenCalled();
  });

  // v1.2 epic #83 Phase 3 (#92): explicit human feedback events.

  it('classifies +1 reaction on a review comment as thumbs_up feedback', async () => {
    const { queue, enqueue } = makeQueue();
    const r = await handleWebhook(
      ctx,
      'reaction',
      {
        action: 'created',
        comment: { id: 12345 },
        reaction: { content: '+1' },
      },
      { queue },
    );
    expect(r).toEqual({ kind: 'feedback', signal: 'thumbs_up', commentId: 12345 });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('classifies -1 reaction as thumbs_down feedback', async () => {
    const { queue, enqueue } = makeQueue();
    const r = await handleWebhook(
      ctx,
      'pull_request_review_comment_reaction',
      {
        action: 'created',
        comment: { id: 999 },
        reaction: { content: '-1' },
      },
      { queue },
    );
    expect(r).toEqual({ kind: 'feedback', signal: 'thumbs_down', commentId: 999 });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('ignores non-quality reactions (heart, laugh, eyes, etc.)', async () => {
    const { queue } = makeQueue();
    for (const content of ['heart', 'laugh', 'eyes', 'rocket', 'hooray', 'confused']) {
      const r = await handleWebhook(
        ctx,
        'reaction',
        { action: 'created', comment: { id: 1 }, reaction: { content } },
        { queue },
      );
      expect(r.kind).toBe('ignored');
    }
  });

  it('ignores reactions with non-created action (avoid duplicate writes on edit/delete)', async () => {
    const { queue } = makeQueue();
    const r = await handleWebhook(
      ctx,
      'reaction',
      { action: 'deleted', comment: { id: 1 }, reaction: { content: '+1' } },
      { queue },
    );
    expect(r.kind).toBe('ignored');
  });

  it('classifies pull_request_review.dismissed as dismissed feedback', async () => {
    const { queue, enqueue } = makeQueue();
    const r = await handleWebhook(
      ctx,
      'pull_request_review',
      { action: 'dismissed', review: { id: 555, state: 'dismissed' } },
      { queue },
    );
    expect(r).toEqual({ kind: 'feedback', signal: 'dismissed', commentId: 555 });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('classifies +1 reaction on a review summary (review.id, no comment.id) as thumbs_up', async () => {
    // Covers the `b.review?.id` fallback branch (line 721) in classifyReactionPayload.
    const { queue, enqueue } = makeQueue();
    const r = await handleWebhook(
      ctx,
      'reaction',
      {
        action: 'created',
        review: { id: 999 },
        reaction: { content: '+1' },
      },
      { queue },
    );
    expect(r).toEqual({ kind: 'feedback', signal: 'thumbs_up', commentId: 999 });
    expect(enqueue).not.toHaveBeenCalled();
  });

  // v1.2 #95: `/feedback` comment command on the GitHub path.

  it('routes /feedback accept through the authz checker and records the outcome', async () => {
    const { queue, enqueue } = makeQueue();
    const checkAuthz = vi.fn().mockResolvedValue({ allowed: true });
    const r = await handleWebhook(
      ctx,
      'issue_comment',
      {
        ...baseRepo,
        sender: { login: 'alice' },
        comment: { body: '/feedback accept abcd1234', user: { login: 'alice' } },
        issue: { number: 9, pull_request: {} },
      },
      { queue, checkAuthz },
    );
    expect(r).toEqual({
      kind: 'feedback_command',
      signal: 'thumbs_up',
      outcome: 'recorded',
      fpPrefix: 'abcd1234',
      prNumber: 9,
    });
    expect(checkAuthz).toHaveBeenCalledWith({ owner: 'o', repo: 'r', username: 'alice' });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('routes /feedback reject (no fp_prefix) through the authz checker', async () => {
    const { queue, enqueue } = makeQueue();
    const checkAuthz = vi.fn().mockResolvedValue({ allowed: true });
    const r = await handleWebhook(
      ctx,
      'issue_comment',
      {
        ...baseRepo,
        sender: { login: 'bob' },
        comment: { body: '/feedback reject', user: { login: 'bob' } },
        issue: { number: 9, pull_request: {} },
      },
      { queue, checkAuthz },
    );
    expect(r).toEqual({
      kind: 'feedback_command',
      signal: 'thumbs_down',
      outcome: 'recorded',
      prNumber: 9,
    });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('routes /feedback dismiss through the authz checker', async () => {
    const { queue } = makeQueue();
    const checkAuthz = vi.fn().mockResolvedValue({ allowed: true });
    const r = await handleWebhook(
      ctx,
      'issue_comment',
      {
        ...baseRepo,
        sender: { login: 'alice' },
        comment: { body: '/feedback dismiss', user: { login: 'alice' } },
        issue: { number: 9, pull_request: {} },
      },
      { queue, checkAuthz },
    );
    expect(r).toMatchObject({
      kind: 'feedback_command',
      signal: 'dismissed',
      outcome: 'recorded',
    });
  });

  it('returns outcome: unauthorized when the authz checker denies', async () => {
    const { queue, enqueue } = makeQueue();
    const checkAuthz = vi.fn().mockResolvedValue({ allowed: false, reason: 'read-only user' });
    const r = await handleWebhook(
      ctx,
      'issue_comment',
      {
        ...baseRepo,
        sender: { login: 'eve' },
        comment: { body: '/feedback accept', user: { login: 'eve' } },
        issue: { number: 9, pull_request: {} },
      },
      { queue, checkAuthz },
    );
    expect(r).toMatchObject({
      kind: 'feedback_command',
      signal: 'thumbs_up',
      outcome: 'unauthorized',
      prNumber: 9,
    });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('propagates fpPrefix on unauthorized /feedback accept with fp_prefix', async () => {
    // Covers the `fpPrefix` spread in the unauthorized branch (line 650).
    const { queue, enqueue } = makeQueue();
    const checkAuthz = vi.fn().mockResolvedValue({ allowed: false, reason: 'read-only user' });
    const r = await handleWebhook(
      ctx,
      'issue_comment',
      {
        ...baseRepo,
        sender: { login: 'eve' },
        comment: { body: '/feedback accept abcd1234', user: { login: 'eve' } },
        issue: { number: 9, pull_request: {} },
      },
      { queue, checkAuthz },
    );
    expect(r).toMatchObject({
      kind: 'feedback_command',
      signal: 'thumbs_up',
      outcome: 'unauthorized',
      fpPrefix: 'abcd1234',
      prNumber: 9,
    });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('returns outcome: unauthorized when no authz checker is wired (fail-closed)', async () => {
    const { queue, enqueue } = makeQueue();
    const r = await handleWebhook(
      ctx,
      'issue_comment',
      {
        ...baseRepo,
        sender: { login: 'alice' },
        comment: { body: '/feedback accept', user: { login: 'alice' } },
        issue: { number: 9, pull_request: {} },
      },
      { queue },
    );
    expect(r).toMatchObject({
      kind: 'feedback_command',
      outcome: 'unauthorized',
    });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('returns outcome: unresolved when PR fields are missing', async () => {
    const { queue, enqueue } = makeQueue();
    const checkAuthz = vi.fn();
    const r = await handleWebhook(
      ctx,
      'issue_comment',
      {
        sender: { login: 'alice' },
        comment: { body: '/feedback accept', user: { login: 'alice' } },
        issue: { number: 9, pull_request: {} },
      },
      { queue, checkAuthz },
    );
    expect(r).toMatchObject({
      kind: 'feedback_command',
      outcome: 'unresolved',
    });
    // authz never called when we cannot identify the PR
    expect(checkAuthz).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('falls back to comment.user.login when sender is absent', async () => {
    const { queue } = makeQueue();
    const checkAuthz = vi.fn().mockResolvedValue({ allowed: true });
    await handleWebhook(
      ctx,
      'issue_comment',
      {
        ...baseRepo,
        comment: { body: '/feedback reject', user: { login: 'commenter' } },
        issue: { number: 9, pull_request: {} },
      },
      { queue, checkAuthz },
    );
    expect(checkAuthz).toHaveBeenCalledWith({
      owner: 'o',
      repo: 'r',
      username: 'commenter',
    });
  });

  it('ignores a /feedback with malformed fp_prefix (too short)', async () => {
    const { queue, enqueue } = makeQueue();
    const checkAuthz = vi.fn();
    const r = await handleWebhook(
      ctx,
      'issue_comment',
      {
        ...baseRepo,
        sender: { login: 'alice' },
        comment: { body: '/feedback reject abc', user: { login: 'alice' } },
        issue: { number: 9, pull_request: {} },
      },
      { queue, checkAuthz },
    );
    // Malformed `/feedback` falls through to `parseCommand`, which sees
    // 'feedback' as an unknown agent command.
    expect(r.kind).toBe('ignored');
    expect(checkAuthz).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('recordFeedbackCommandOutcome is callable for worker re-labelling (rate_limited / unresolved)', () => {
    // Just pin the contract; the underlying counter is a stubbed
    // counter at test time so we only assert no throw.
    expect(() => recordFeedbackCommandOutcome('github', 'thumbs_up', 'rate_limited')).not.toThrow();
    expect(() =>
      recordFeedbackCommandOutcome('codecommit', 'thumbs_down', 'unresolved'),
    ).not.toThrow();
  });

  // Tail fall-through: events we don't handle (e.g. `star`) take the
  // final `return { kind: 'ignored', reason: ... }` branch at the end
  // of handleWebhook. Documents the receiver's contract that unknown
  // events are ignored, not 500'd.
  it("returns ignored for unhandled event types (e.g. 'star')", async () => {
    const { queue, enqueue } = makeQueue();
    const r = await handleWebhook(
      ctx,
      'star' as Parameters<typeof handleWebhook>[1],
      {},
      { queue },
    );
    expect(r.kind).toBe('ignored');
    if (r.kind === 'ignored') {
      expect(r.reason).toContain("unhandled event 'star'");
    }
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('ignores pull_request_review actions other than dismissed (e.g. submitted, edited) without enqueueing', async () => {
    const { queue, enqueue } = makeQueue();
    const r = await handleWebhook(
      ctx,
      'pull_request_review',
      { action: 'submitted', review: { id: 1, state: 'approved' } },
      { queue },
    );
    // Falls through to the comment-command parser, which sees no
    // `comment.body` and treats it as 'ignored'.
    expect(r.kind).toBe('ignored');
    expect(enqueue).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// #157 trigger control: slash commands
// ---------------------------------------------------------------------------

describe('handleWebhook — slash commands (#157)', () => {
  it('enqueues /review command when authorized (no DB needed)', async () => {
    const { queue, enqueue } = makeQueue();
    const checkAuthz = vi.fn().mockResolvedValue({ allowed: true });
    const r = await handleWebhook(
      ctx,
      'issue_comment',
      {
        ...baseRepo,
        sender: { login: 'alice' },
        comment: { body: '/review', user: { login: 'alice' } },
        issue: { number: 9, pull_request: {} },
      },
      { queue, checkAuthz },
    );
    expect(r.kind).toBe('enqueued');
    expect(enqueue).toHaveBeenCalledOnce();
    const call = enqueue.mock.calls[0]?.[0];
    expect(call.triggeredBy).toBe('comment.command');
    expect(call.pathScope).toBeUndefined();
    expect(checkAuthz).toHaveBeenCalledWith({ owner: 'o', repo: 'r', username: 'alice' });
  });

  it('enqueues /review with pathScope when a glob path is provided', async () => {
    const { queue, enqueue } = makeQueue();
    const checkAuthz = vi.fn().mockResolvedValue({ allowed: true });
    const r = await handleWebhook(
      ctx,
      'issue_comment',
      {
        ...baseRepo,
        sender: { login: 'alice' },
        comment: { body: '/review src/**', user: { login: 'alice' } },
        issue: { number: 9, pull_request: {} },
      },
      { queue, checkAuthz },
    );
    expect(r.kind).toBe('enqueued');
    const call = enqueue.mock.calls[0]?.[0];
    expect(call.pathScope).toEqual(['src/**']);
  });

  it('silently ignores /review from unauthorized user (no reply)', async () => {
    const { queue, enqueue } = makeQueue();
    const checkAuthz = vi.fn().mockResolvedValue({ allowed: false, reason: 'read-only' });
    const r = await handleWebhook(
      ctx,
      'issue_comment',
      {
        ...baseRepo,
        sender: { login: 'eve' },
        comment: { body: '/review', user: { login: 'eve' } },
        issue: { number: 9, pull_request: {} },
      },
      { queue, checkAuthz },
    );
    expect(r.kind).toBe('ignored');
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('silently ignores /review when no checkAuthz is wired (fail-closed)', async () => {
    const { queue, enqueue } = makeQueue();
    const r = await handleWebhook(
      ctx,
      'issue_comment',
      {
        ...baseRepo,
        sender: { login: 'alice' },
        comment: { body: '/review', user: { login: 'alice' } },
        issue: { number: 9, pull_request: {} },
      },
      { queue },
    );
    expect(r.kind).toBe('ignored');
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('returns noop for /skip command (authorized)', async () => {
    const { queue, enqueue } = makeQueue();
    const checkAuthz = vi.fn().mockResolvedValue({ allowed: true });
    const r = await handleWebhook(
      ctx,
      'issue_comment',
      {
        ...baseRepo,
        sender: { login: 'alice' },
        comment: { body: '/skip', user: { login: 'alice' } },
        issue: { number: 9, pull_request: {} },
      },
      { queue, checkAuthz },
    );
    expect(r.kind).toBe('noop');
    if (r.kind === 'noop') expect(r.reason).toContain('skip');
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('silently ignores /skip from unauthorized user', async () => {
    const { queue, enqueue } = makeQueue();
    const checkAuthz = vi.fn().mockResolvedValue({ allowed: false, reason: 'read-only' });
    const r = await handleWebhook(
      ctx,
      'issue_comment',
      {
        ...baseRepo,
        sender: { login: 'eve' },
        comment: { body: '/skip', user: { login: 'eve' } },
        issue: { number: 9, pull_request: {} },
      },
      { queue, checkAuthz },
    );
    expect(r.kind).toBe('ignored');
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('returns noop for /resume command (authorized)', async () => {
    const { queue, enqueue } = makeQueue();
    const checkAuthz = vi.fn().mockResolvedValue({ allowed: true });
    const r = await handleWebhook(
      ctx,
      'issue_comment',
      {
        ...baseRepo,
        sender: { login: 'alice' },
        comment: { body: '/resume', user: { login: 'alice' } },
        issue: { number: 9, pull_request: {} },
      },
      { queue, checkAuthz },
    );
    expect(r.kind).toBe('noop');
    if (r.kind === 'noop') expect(r.reason).toContain('resume');
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('slash commands are case-insensitive', async () => {
    const { queue, enqueue } = makeQueue();
    const checkAuthz = vi.fn().mockResolvedValue({ allowed: true });
    const r = await handleWebhook(
      ctx,
      'issue_comment',
      {
        ...baseRepo,
        sender: { login: 'alice' },
        comment: { body: '/REVIEW', user: { login: 'alice' } },
        issue: { number: 9, pull_request: {} },
      },
      { queue, checkAuthz },
    );
    expect(r.kind).toBe('enqueued');
    expect(enqueue).toHaveBeenCalledOnce();
  });

  it('slash commands work from pull_request_review_comment event', async () => {
    const { queue, enqueue } = makeQueue();
    const checkAuthz = vi.fn().mockResolvedValue({ allowed: true });
    const r = await handleWebhook(
      ctx,
      'pull_request_review_comment',
      {
        ...baseRepo,
        sender: { login: 'alice' },
        comment: { body: '/review src/**', user: { login: 'alice' } },
        pull_request: { number: 5 },
      },
      { queue, checkAuthz },
    );
    expect(r.kind).toBe('enqueued');
    expect(enqueue).toHaveBeenCalledOnce();
    const call = enqueue.mock.calls[0]?.[0];
    expect(call.pathScope).toEqual(['src/**']);
  });
});

// ---------------------------------------------------------------------------
// #157 trigger control: /skip and /resume with DB (paused flag)
// ---------------------------------------------------------------------------

describe('handleWebhook — /skip and /resume with DB', () => {
  it('/skip writes paused=true to review_state via DB', async () => {
    const { queue } = makeQueue();
    const { db, tx } = makeDb();
    const checkAuthz = vi.fn().mockResolvedValue({ allowed: true });
    await handleWebhook(
      ctx,
      'issue_comment',
      {
        ...baseRepo,
        sender: { login: 'alice' },
        comment: { body: '/skip', user: { login: 'alice' } },
        issue: { number: 9, pull_request: {} },
      },
      { queue, db, checkAuthz },
    );
    expect(tx.update).toHaveBeenCalledOnce();
    const setArg = tx.update.mock.results[0]?.value?.set?.mock?.calls?.[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(setArg?.paused).toBe(true);
  });

  it('/resume writes paused=false to review_state via DB', async () => {
    const { queue } = makeQueue();
    const { db, tx } = makeDb();
    const checkAuthz = vi.fn().mockResolvedValue({ allowed: true });
    await handleWebhook(
      ctx,
      'issue_comment',
      {
        ...baseRepo,
        sender: { login: 'alice' },
        comment: { body: '/resume', user: { login: 'alice' } },
        issue: { number: 9, pull_request: {} },
      },
      { queue, db, checkAuthz },
    );
    expect(tx.update).toHaveBeenCalledOnce();
    const setArg = tx.update.mock.results[0]?.value?.set?.mock?.calls?.[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(setArg?.paused).toBe(false);
  });

  it('/skip does not write to DB when db is not wired', async () => {
    const { queue } = makeQueue();
    const checkAuthz = vi.fn().mockResolvedValue({ allowed: true });
    const r = await handleWebhook(
      ctx,
      'issue_comment',
      {
        ...baseRepo,
        sender: { login: 'alice' },
        comment: { body: '/skip', user: { login: 'alice' } },
        issue: { number: 9, pull_request: {} },
      },
      { queue, checkAuthz },
    );
    // No DB wired → still returns noop (command acknowledged without persistence).
    expect(r.kind).toBe('noop');
  });
});

// ---------------------------------------------------------------------------
// #157 trigger control: [skip review] marker
// ---------------------------------------------------------------------------

describe('handleWebhook — [skip review] marker', () => {
  it('suppresses auto-review when [skip review] is in the PR title', async () => {
    const { queue, enqueue } = makeQueue();
    const r = await handleWebhook(
      ctx,
      'pull_request',
      {
        action: 'synchronize',
        ...baseRepo,
        pull_request: { number: 7, draft: false, title: '[skip review] my PR', body: '' },
      },
      { queue },
    );
    expect(r.kind).toBe('ignored');
    if (r.kind === 'ignored') expect(r.reason).toContain('[skip review]');
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('suppresses auto-review when [skip review] is in the PR body', async () => {
    const { queue, enqueue } = makeQueue();
    const r = await handleWebhook(
      ctx,
      'pull_request',
      {
        action: 'opened',
        ...baseRepo,
        pull_request: {
          number: 7,
          draft: false,
          title: 'normal title',
          body: 'please [skip review] for now',
        },
      },
      { queue },
    );
    expect(r.kind).toBe('ignored');
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('[skip review] matching is case-insensitive', async () => {
    const { queue, enqueue } = makeQueue();
    const r = await handleWebhook(
      ctx,
      'pull_request',
      {
        action: 'synchronize',
        ...baseRepo,
        pull_request: { number: 7, draft: false, title: '[SKIP REVIEW]', body: '' },
      },
      { queue },
    );
    expect(r.kind).toBe('ignored');
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('does NOT suppress ready_for_review even when [skip review] marker present (explicit conversion)', async () => {
    // `ready_for_review` is not in PUSH_TRIGGERED_ACTIONS — the [skip review]
    // check does not apply because the user explicitly converted the draft.
    const { queue, enqueue } = makeQueue();
    const r = await handleWebhook(
      ctx,
      'pull_request',
      {
        action: 'ready_for_review',
        ...baseRepo,
        pull_request: { number: 7, draft: false, title: '[skip review] draft done', body: '' },
      },
      { queue },
    );
    expect(r.kind).toBe('enqueued');
    expect(enqueue).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// #157 trigger control: label-based triggers
// ---------------------------------------------------------------------------

describe('handleWebhook — label triggers (#157)', () => {
  it('fires review when a trigger_label is applied to the PR', async () => {
    const { queue, enqueue } = makeQueue();
    const r = await handleWebhook(
      ctx,
      'pull_request',
      {
        action: 'labeled',
        ...baseRepo,
        pull_request: { number: 7, draft: false },
        label: { name: 'needs-review' },
      },
      { queue, triggerConfig: { trigger_labels: ['needs-review'], skip_labels: [] } },
    );
    expect(r.kind).toBe('enqueued');
    expect(enqueue).toHaveBeenCalledOnce();
  });

  it('ignores labeled event when label is not in trigger_labels', async () => {
    const { queue, enqueue } = makeQueue();
    const r = await handleWebhook(
      ctx,
      'pull_request',
      {
        action: 'labeled',
        ...baseRepo,
        pull_request: { number: 7, draft: false },
        label: { name: 'bug' },
      },
      { queue, triggerConfig: { trigger_labels: ['needs-review'], skip_labels: [] } },
    );
    expect(r.kind).toBe('ignored');
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('ignores labeled event when triggerConfig is not wired', async () => {
    // When triggerConfig is absent, labeled events are not in ENQUEUE_PR_ACTIONS
    // so they fall through to the standard action filter.
    const { queue, enqueue } = makeQueue();
    const r = await handleWebhook(
      ctx,
      'pull_request',
      {
        action: 'labeled',
        ...baseRepo,
        pull_request: { number: 7, draft: false },
        label: { name: 'needs-review' },
      },
      { queue },
    );
    expect(r.kind).toBe('ignored');
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('trigger_labels matching is case-insensitive', async () => {
    const { queue, enqueue } = makeQueue();
    const r = await handleWebhook(
      ctx,
      'pull_request',
      {
        action: 'labeled',
        ...baseRepo,
        pull_request: { number: 7, draft: false },
        label: { name: 'Needs-Review' },
      },
      { queue, triggerConfig: { trigger_labels: ['needs-review'], skip_labels: [] } },
    );
    expect(r.kind).toBe('enqueued');
    expect(enqueue).toHaveBeenCalledOnce();
  });

  it('suppresses push-triggered review when PR carries a skip_label', async () => {
    const { queue, enqueue } = makeQueue();
    const r = await handleWebhook(
      ctx,
      'pull_request',
      {
        action: 'synchronize',
        ...baseRepo,
        pull_request: {
          number: 7,
          draft: false,
          labels: [{ name: 'no-review' }],
        },
      },
      { queue, triggerConfig: { trigger_labels: [], skip_labels: ['no-review'] } },
    );
    expect(r.kind).toBe('ignored');
    if (r.kind === 'ignored') expect(r.reason).toContain('skip_label');
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('skip_labels matching is case-insensitive', async () => {
    const { queue, enqueue } = makeQueue();
    const r = await handleWebhook(
      ctx,
      'pull_request',
      {
        action: 'opened',
        ...baseRepo,
        pull_request: {
          number: 7,
          draft: false,
          labels: [{ name: 'NO-REVIEW' }],
        },
      },
      { queue, triggerConfig: { trigger_labels: [], skip_labels: ['no-review'] } },
    );
    expect(r.kind).toBe('ignored');
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('does not apply skip_labels check to ready_for_review', async () => {
    // ready_for_review is not in PUSH_TRIGGERED_ACTIONS, so skip_labels don't block it.
    const { queue, enqueue } = makeQueue();
    const r = await handleWebhook(
      ctx,
      'pull_request',
      {
        action: 'ready_for_review',
        ...baseRepo,
        pull_request: {
          number: 7,
          draft: false,
          labels: [{ name: 'no-review' }],
        },
      },
      { queue, triggerConfig: { trigger_labels: [], skip_labels: ['no-review'] } },
    );
    expect(r.kind).toBe('enqueued');
    expect(enqueue).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// #157 trigger control: draft PR and ready_for_review
// ---------------------------------------------------------------------------

describe('handleWebhook — draft PR / ready_for_review (#157)', () => {
  it('enqueues ready_for_review when draft is converted (existing behaviour confirmed)', async () => {
    const { queue, enqueue } = makeQueue();
    const r = await handleWebhook(
      ctx,
      'pull_request',
      {
        action: 'ready_for_review',
        ...baseRepo,
        pull_request: { number: 7, draft: false, head: { sha: 'abc1234' } },
      },
      { queue },
    );
    expect(r.kind).toBe('enqueued');
    expect(enqueue).toHaveBeenCalledOnce();
    const call = enqueue.mock.calls[0]?.[0];
    expect(call.triggeredBy).toBe('pull_request.ready_for_review');
  });

  it('still ignores draft synchronize (draft flag true)', async () => {
    const { queue, enqueue } = makeQueue();
    const r = await handleWebhook(
      ctx,
      'pull_request',
      { action: 'synchronize', ...baseRepo, pull_request: { number: 7, draft: true } },
      { queue },
    );
    expect(r.kind).toBe('ignored');
    expect(enqueue).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// #157 trigger control: legacy @review-agent review — auth-gated
// ---------------------------------------------------------------------------

describe('handleWebhook — legacy @review-agent review with auth gate (#157)', () => {
  it('silently ignores unauthorized @review-agent review (no reply)', async () => {
    const { queue, enqueue } = makeQueue();
    const checkAuthz = vi.fn().mockResolvedValue({ allowed: false, reason: 'read-only' });
    const r = await handleWebhook(
      ctx,
      'issue_comment',
      {
        ...baseRepo,
        sender: { login: 'eve' },
        comment: { body: '@review-agent review', user: { login: 'eve' } },
        issue: { number: 9, pull_request: {} },
      },
      { queue, checkAuthz },
    );
    expect(r.kind).toBe('ignored');
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('silently ignores @review-agent review when no authz checker wired', async () => {
    const { queue, enqueue } = makeQueue();
    const r = await handleWebhook(
      ctx,
      'issue_comment',
      {
        ...baseRepo,
        sender: { login: 'alice' },
        comment: { body: '@review-agent review', user: { login: 'alice' } },
        issue: { number: 9, pull_request: {} },
      },
      // No checkAuthz wired → fail-closed.
      { queue },
    );
    expect(r.kind).toBe('ignored');
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('enqueues @review-agent review when checkAuthz allows it', async () => {
    const { queue, enqueue } = makeQueue();
    const checkAuthz = vi.fn().mockResolvedValue({ allowed: true });
    const r = await handleWebhook(
      ctx,
      'issue_comment',
      {
        ...baseRepo,
        sender: { login: 'alice' },
        comment: { body: '@review-agent review', user: { login: 'alice' } },
        issue: { number: 9, pull_request: {} },
      },
      { queue, checkAuthz },
    );
    expect(r.kind).toBe('enqueued');
    expect(enqueue).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// #157 trigger control: debounce
// ---------------------------------------------------------------------------

describe('handleWebhook — debounce (#157)', () => {
  function makeDbWithReviewState(updatedAt: Date) {
    // Returns a fake DB that simulates finding a review_state row with the
    // given `updatedAt`. The select chain returns one row.
    const selectResult = {
      from: vi.fn(),
    };
    const whereResult = {
      limit: vi.fn(),
    };
    const limitResult = [{ updatedAt, paused: false }];

    whereResult.limit.mockResolvedValue(limitResult);
    selectResult.from.mockReturnValue({ where: vi.fn().mockReturnValue(whereResult) });

    const tx = {
      select: vi.fn().mockReturnValue(selectResult),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
      }),
      execute: vi.fn().mockResolvedValue([{ tenant: '11' }]),
    };

    const db = {
      transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(tx)),
    } as unknown as DbClient;

    return { db, tx };
  }

  it('debounces /review when a review was updated within the window', async () => {
    const { queue, enqueue } = makeQueue();
    const checkAuthz = vi.fn().mockResolvedValue({ allowed: true });
    const nowDate = new Date('2026-06-04T12:00:30Z');
    // Simulate updatedAt 5 seconds ago (within 30s window).
    const { db } = makeDbWithReviewState(new Date('2026-06-04T12:00:25Z'));

    const r = await handleWebhook(
      ctx,
      'issue_comment',
      {
        ...baseRepo,
        sender: { login: 'alice' },
        comment: { body: '/review', user: { login: 'alice' } },
        issue: { number: 9, pull_request: {} },
      },
      { queue, checkAuthz, db, now: () => nowDate },
    );
    expect(r.kind).toBe('ignored');
    if (r.kind === 'ignored') expect(r.reason).toContain('debounced');
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('does NOT debounce /review when review was updated outside the window', async () => {
    const { queue, enqueue } = makeQueue();
    const checkAuthz = vi.fn().mockResolvedValue({ allowed: true });
    const nowDate = new Date('2026-06-04T12:01:00Z');
    // Simulate updatedAt 60 seconds ago (outside 30s window).
    const { db } = makeDbWithReviewState(new Date('2026-06-04T12:00:00Z'));

    const r = await handleWebhook(
      ctx,
      'issue_comment',
      {
        ...baseRepo,
        sender: { login: 'alice' },
        comment: { body: '/review', user: { login: 'alice' } },
        issue: { number: 9, pull_request: {} },
      },
      { queue, checkAuthz, db, now: () => nowDate },
    );
    expect(r.kind).toBe('enqueued');
    expect(enqueue).toHaveBeenCalledOnce();
  });

  it('does not debounce when no DB is wired (fail-open)', async () => {
    const { queue, enqueue } = makeQueue();
    const checkAuthz = vi.fn().mockResolvedValue({ allowed: true });
    const r = await handleWebhook(
      ctx,
      'issue_comment',
      {
        ...baseRepo,
        sender: { login: 'alice' },
        comment: { body: '/review', user: { login: 'alice' } },
        issue: { number: 9, pull_request: {} },
      },
      { queue, checkAuthz },
    );
    expect(r.kind).toBe('enqueued');
    expect(enqueue).toHaveBeenCalledOnce();
  });

  it('does not debounce when DB throws (fail-open on DB error)', async () => {
    const { queue, enqueue } = makeQueue();
    const checkAuthz = vi.fn().mockResolvedValue({ allowed: true });
    const nowDate = new Date('2026-06-04T12:00:30Z');

    // Simulate a DB that throws during the select.
    const db = {
      transaction: vi.fn().mockRejectedValue(new Error('DB connection lost')),
    } as unknown as DbClient;

    const r = await handleWebhook(
      ctx,
      'issue_comment',
      {
        ...baseRepo,
        sender: { login: 'alice' },
        comment: { body: '/review', user: { login: 'alice' } },
        issue: { number: 9, pull_request: {} },
      },
      { queue, checkAuthz, db, now: () => nowDate },
    );
    // Even though the DB threw, we fail-open and do NOT debounce.
    expect(r.kind).toBe('enqueued');
    expect(enqueue).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// #157 trigger control: paused state check on push events
// ---------------------------------------------------------------------------

describe('handleWebhook — paused PR suppresses push-triggered auto-review (#157)', () => {
  /** Build a fake DB whose review_state select returns paused=<value>. */
  function makeDbWithPaused(paused: boolean) {
    const limitResult = [{ updatedAt: new Date('2026-06-01T00:00:00Z'), paused }];
    const whereResult = { limit: vi.fn().mockResolvedValue(limitResult) };
    const selectResult = {
      from: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue(whereResult) }),
    };
    const tx = {
      select: vi.fn().mockReturnValue(selectResult),
      execute: vi.fn().mockResolvedValue([{ tenant: '11' }]),
    };
    const db = {
      transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(tx)),
    } as unknown as DbClient;
    return { db };
  }

  it('suppresses push (synchronize) when review_state.paused=true', async () => {
    const { queue, enqueue } = makeQueue();
    const { db } = makeDbWithPaused(true);
    const r = await handleWebhook(
      ctx,
      'pull_request',
      {
        action: 'synchronize',
        ...baseRepo,
        pull_request: { number: 7, draft: false },
      },
      { queue, db },
    );
    expect(r.kind).toBe('ignored');
    if (r.kind === 'ignored') expect(r.reason).toContain('paused');
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('enqueues push (synchronize) when review_state.paused=false (resumed)', async () => {
    const { queue, enqueue } = makeQueue();
    const { db } = makeDbWithPaused(false);
    const r = await handleWebhook(
      ctx,
      'pull_request',
      {
        action: 'synchronize',
        ...baseRepo,
        pull_request: { number: 7, draft: false },
      },
      { queue, db },
    );
    expect(r.kind).toBe('enqueued');
    expect(enqueue).toHaveBeenCalledOnce();
  });

  it('fail-open: enqueues push when paused DB read throws', async () => {
    const { queue, enqueue } = makeQueue();
    const db = {
      transaction: vi.fn().mockRejectedValue(new Error('DB connection lost')),
    } as unknown as DbClient;
    const r = await handleWebhook(
      ctx,
      'pull_request',
      {
        action: 'synchronize',
        ...baseRepo,
        pull_request: { number: 7, draft: false },
      },
      { queue, db },
    );
    // DB error → fail-open → review proceeds normally.
    expect(r.kind).toBe('enqueued');
    expect(enqueue).toHaveBeenCalledOnce();
  });

  it('does NOT suppress ready_for_review even when review_state.paused=true', async () => {
    // ready_for_review is not in PUSH_TRIGGERED_ACTIONS so the paused
    // check does not apply — explicit draft conversion always fires.
    const { queue, enqueue } = makeQueue();
    const { db } = makeDbWithPaused(true);
    const r = await handleWebhook(
      ctx,
      'pull_request',
      {
        action: 'ready_for_review',
        ...baseRepo,
        pull_request: { number: 7, draft: false },
      },
      { queue, db },
    );
    expect(r.kind).toBe('enqueued');
    expect(enqueue).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// #157 authz: missing owner/repo/username edge case
// ---------------------------------------------------------------------------

describe('handleWebhook — command authz missing fields (#157)', () => {
  it('silently ignores slash /review when repository fields are missing from payload', async () => {
    // Covers the `!owner || !repo || !username` branch of checkCommandAuthz.
    const { queue, enqueue } = makeQueue();
    const checkAuthz = vi.fn().mockResolvedValue({ allowed: true });
    const r = await handleWebhook(
      ctx,
      'issue_comment',
      {
        // Omit repository entirely — owner/repo will be undefined.
        installation: { id: 11 },
        sender: { login: 'alice' },
        comment: { body: '/review', user: { login: 'alice' } },
        issue: { number: 9, pull_request: {} },
      },
      { queue, checkAuthz },
    );
    expect(r.kind).toBe('ignored');
    expect(enqueue).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// installation event persistence (#126)
// ---------------------------------------------------------------------------

const installationPayload = {
  installation: {
    id: 99,
    app_id: 42,
    account: { login: 'acme-org', type: 'Organization' },
  },
};

describe('handleWebhook — installation events with db', () => {
  it('installation.created upserts a row and returns kind:installation', async () => {
    const { queue } = makeQueue();
    const { db, tx, insertResult } = makeDb();
    const r = await handleWebhook(
      ctx,
      'installation',
      { action: 'created', ...installationPayload },
      { queue, db, now: () => new Date('2026-06-04T00:00:00Z') },
    );
    expect(r).toEqual({ kind: 'installation', action: 'created', installationId: 99 });
    expect(tx.insert).toHaveBeenCalledOnce();
    // Verify the .values() argument contains the correct fields.
    const valuesInsertResult = tx.insert.mock.results[0]?.value as {
      values: ReturnType<typeof vi.fn>;
    };
    const valuesArg = valuesInsertResult.values.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(valuesArg.installationId).toEqual(BigInt(99));
    expect(valuesArg.appId).toEqual(BigInt(42));
    expect(valuesArg.accountLogin).toBe('acme-org');
    expect(valuesArg.accountType).toBe('Organization');
    expect(valuesArg.setupAction).toBe('install');
    expect(valuesArg.suspendedAt).toBeNull();
    // Verify the .onConflictDoUpdate().set branch also clears suspendedAt
    // (this is the code path that runs for an already-existing row).
    const conflictArg = insertResult.onConflictDoUpdate.mock.calls[0]?.[0] as {
      set: Record<string, unknown>;
    };
    expect(conflictArg.set.suspendedAt).toBeNull();
  });

  it('installation.unsuspend upserts with suspendedAt:null', async () => {
    const { queue } = makeQueue();
    const { db, tx, insertResult } = makeDb();
    const r = await handleWebhook(
      ctx,
      'installation',
      { action: 'unsuspend', ...installationPayload },
      { queue, db, now: () => new Date('2026-06-04T00:00:00Z') },
    );
    expect(r).toEqual({ kind: 'installation', action: 'unsuspend', installationId: 99 });
    expect(tx.insert).toHaveBeenCalledOnce();
    // Verify suspendedAt is set to null in both the .values() and .onConflictDoUpdate() calls.
    const valuesCall = tx.insert.mock.results[0]?.value as {
      values: ReturnType<typeof vi.fn>;
    };
    const valuesArg = valuesCall.values.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(valuesArg.suspendedAt).toBeNull();
    // Also assert the conflict-update branch (the realistic path for an already-existing row).
    const conflictArg = insertResult.onConflictDoUpdate.mock.calls[0]?.[0] as {
      set: Record<string, unknown>;
    };
    expect(conflictArg.set.suspendedAt).toBeNull();
  });

  it('installation.suspend updates suspendedAt and returns kind:installation', async () => {
    const { queue } = makeQueue();
    const { db, tx } = makeDb();
    const r = await handleWebhook(
      ctx,
      'installation',
      { action: 'suspend', ...installationPayload },
      { queue, db, now: () => new Date('2026-06-04T00:00:00Z') },
    );
    expect(r).toEqual({ kind: 'installation', action: 'suspend', installationId: 99 });
    expect(tx.update).toHaveBeenCalledOnce();
    expect(tx.insert).not.toHaveBeenCalled();
  });

  it('installation.deleted physically deletes the row and returns kind:installation', async () => {
    const { queue } = makeQueue();
    const { db, tx } = makeDb();
    const r = await handleWebhook(
      ctx,
      'installation',
      { action: 'deleted', ...installationPayload },
      { queue, db, now: () => new Date('2026-06-04T00:00:00Z') },
    );
    expect(r).toEqual({ kind: 'installation', action: 'deleted', installationId: 99 });
    expect(tx.delete).toHaveBeenCalledOnce();
    expect(tx.insert).not.toHaveBeenCalled();
    expect(tx.update).not.toHaveBeenCalled();
  });

  it('installation event with unknown action returns noop without DB write', async () => {
    const { queue } = makeQueue();
    const { db, tx } = makeDb();
    const r = await handleWebhook(
      ctx,
      'installation',
      { action: 'new_permissions_accepted', ...installationPayload },
      { queue, db },
    );
    expect(r.kind).toBe('noop');
    expect(tx.insert).not.toHaveBeenCalled();
    expect(tx.update).not.toHaveBeenCalled();
    expect(tx.delete).not.toHaveBeenCalled();
  });

  it('installation event with no db falls back to noop (db-not-injected path)', async () => {
    const { queue } = makeQueue();
    const r = await handleWebhook(
      ctx,
      'installation',
      { action: 'created', ...installationPayload },
      { queue },
    );
    expect(r.kind).toBe('noop');
  });

  it('installation.created missing account fields returns ignored without DB write', async () => {
    const { queue } = makeQueue();
    const { db, tx } = makeDb();
    const r = await handleWebhook(
      ctx,
      'installation',
      { action: 'created', installation: { id: 99, app_id: 42 } },
      { queue, db },
    );
    expect(r.kind).toBe('ignored');
    expect(tx.insert).not.toHaveBeenCalled();
  });

  it('installation event missing installation.id returns ignored', async () => {
    const { queue } = makeQueue();
    const { db, tx } = makeDb();
    const r = await handleWebhook(ctx, 'installation', { action: 'created' }, { queue, db });
    expect(r.kind).toBe('ignored');
    expect(tx.insert).not.toHaveBeenCalled();
  });

  it('installation_repositories continues to be a no-op', async () => {
    const { queue, enqueue } = makeQueue();
    const { db } = makeDb();
    const r = await handleWebhook(ctx, 'installation_repositories', {}, { queue, db });
    expect(r.kind).toBe('noop');
    expect(enqueue).not.toHaveBeenCalled();
  });
});
