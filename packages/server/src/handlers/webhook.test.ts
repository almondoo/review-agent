import type { Context } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { handleWebhook } from './webhook.js';

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
});
