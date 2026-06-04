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

  it('enqueues @review-agent review command', async () => {
    const { queue, enqueue } = makeQueue();
    const r = await handleWebhook(
      ctx,
      'issue_comment',
      {
        ...baseRepo,
        comment: { body: 'thanks! @review-agent review' },
        issue: { number: 9, pull_request: {} },
      },
      { queue },
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
    const r = await handleWebhook(
      ctx,
      'issue_comment',
      {
        ...baseRepo,
        comment: { body: '@ReView-AGent REVIEW' },
        issue: { number: 9, pull_request: {} },
      },
      { queue },
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
