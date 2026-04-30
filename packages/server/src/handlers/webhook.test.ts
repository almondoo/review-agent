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
});
