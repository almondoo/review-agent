import type { Context } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { SnsMessage } from '../middleware/verify-sns-signature.js';
import { handleCodecommitWebhook } from './codecommit-webhook.js';

const ctx = {} as unknown as Context;

function makeQueue() {
  const enqueue = vi.fn().mockResolvedValue({ messageId: 'm-cc-1' });
  return {
    queue: { enqueue, dequeue: vi.fn() },
    enqueue,
  };
}

function makeEnvelope(overrides: Partial<SnsMessage> = {}): SnsMessage {
  return {
    Type: 'Notification',
    MessageId: 'sns-msg-1',
    TopicArn: 'arn:aws:sns:us-east-1:111111111111:t',
    Timestamp: '2026-04-30T00:00:00Z',
    Signature: 'sig',
    SignatureVersion: '2',
    SigningCertURL: 'https://sns.us-east-1.amazonaws.com/cert.pem',
    Message: '',
    ...overrides,
  };
}

function eventBridgeMessage(detail: Record<string, unknown>): string {
  return JSON.stringify({
    source: 'aws.codecommit',
    'detail-type': 'CodeCommit Pull Request State Change',
    detail,
  });
}

describe('handleCodecommitWebhook', () => {
  it('confirms an SNS SubscriptionConfirmation by GETting the SubscribeURL', async () => {
    const { queue, enqueue } = makeQueue();
    const confirmFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const envelope = makeEnvelope({
      Type: 'SubscriptionConfirmation',
      SubscribeURL: 'https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&Token=t',
    });
    const r = await handleCodecommitWebhook(ctx, envelope, { queue, confirmFetch });
    expect(r).toEqual({ kind: 'subscription_confirmed' });
    expect(confirmFetch).toHaveBeenCalledWith(envelope.SubscribeURL);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('reports subscription_failed when SubscribeURL fetch returns non-2xx', async () => {
    const { queue } = makeQueue();
    const confirmFetch = vi.fn().mockResolvedValue({ ok: false, status: 503 });
    const envelope = makeEnvelope({
      Type: 'SubscriptionConfirmation',
      SubscribeURL: 'https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription',
    });
    const r = await handleCodecommitWebhook(ctx, envelope, { queue, confirmFetch });
    expect(r).toEqual({ kind: 'subscription_failed', status: 503 });
  });

  it('ignores SubscriptionConfirmation without SubscribeURL', async () => {
    const { queue } = makeQueue();
    const envelope = makeEnvelope({ Type: 'SubscriptionConfirmation' });
    const r = await handleCodecommitWebhook(ctx, envelope, { queue });
    expect(r.kind).toBe('ignored');
  });

  it('enqueues pullRequestCreated as pull_request.opened', async () => {
    const { queue, enqueue } = makeQueue();
    const envelope = makeEnvelope({
      Message: eventBridgeMessage({
        event: 'pullRequestCreated',
        pullRequestId: '42',
        repositoryName: 'repo-a',
        sourceCommit: 'abc1234567',
      }),
    });
    const r = await handleCodecommitWebhook(ctx, envelope, {
      queue,
      now: () => new Date('2026-04-30T00:00:00Z'),
    });
    expect(r).toEqual({ kind: 'enqueued', messageId: 'm-cc-1' });
    expect(enqueue).toHaveBeenCalledOnce();
    const call = enqueue.mock.calls[0]?.[0];
    expect(call.triggeredBy).toBe('pull_request.opened');
    expect(call.prRef).toMatchObject({
      platform: 'codecommit',
      owner: '',
      repo: 'repo-a',
      number: 42,
      headSha: 'abc1234567',
    });
    expect(call.installationId).toBe('sns-msg-1');
  });

  it('enqueues pullRequestSourceBranchUpdated as pull_request.synchronize', async () => {
    const { queue, enqueue } = makeQueue();
    const envelope = makeEnvelope({
      Message: eventBridgeMessage({
        event: 'pullRequestSourceBranchUpdated',
        pullRequestId: 7,
        repositoryName: 'repo-b',
      }),
    });
    const r = await handleCodecommitWebhook(ctx, envelope, { queue });
    expect(r.kind).toBe('enqueued');
    expect(enqueue.mock.calls[0]?.[0].triggeredBy).toBe('pull_request.synchronize');
  });

  it('accepts pullRequestSourceReferenceUpdated as a synchronize alias', async () => {
    const { queue, enqueue } = makeQueue();
    const envelope = makeEnvelope({
      Message: eventBridgeMessage({
        event: 'pullRequestSourceReferenceUpdated',
        pullRequestId: '8',
        repositoryName: 'repo-c',
      }),
    });
    const r = await handleCodecommitWebhook(ctx, envelope, { queue });
    expect(r.kind).toBe('enqueued');
    expect(enqueue.mock.calls[0]?.[0].triggeredBy).toBe('pull_request.synchronize');
  });

  it('enqueues commentOnPullRequest when comment contains @review-agent review', async () => {
    const { queue, enqueue } = makeQueue();
    const envelope = makeEnvelope({
      Message: eventBridgeMessage({
        event: 'commentOnPullRequest',
        pullRequestId: '9',
        repositoryName: 'repo-d',
        commentContent: 'thanks! @review-agent review',
      }),
    });
    const r = await handleCodecommitWebhook(ctx, envelope, { queue });
    expect(r.kind).toBe('enqueued');
    const call = enqueue.mock.calls[0]?.[0];
    expect(call.triggeredBy).toBe('comment.command');
    expect(call.prRef.number).toBe(9);
  });

  it('returns noop with "not yet implemented" for unsupported commands', async () => {
    const { queue, enqueue } = makeQueue();
    const envelope = makeEnvelope({
      Message: eventBridgeMessage({
        event: 'commentOnPullRequest',
        pullRequestId: '9',
        repositoryName: 'repo-d',
        commentContent: '@review-agent help',
      }),
    });
    const r = await handleCodecommitWebhook(ctx, envelope, { queue });
    expect(r).toEqual({ kind: 'noop', reason: "command 'help' not yet implemented" });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('ignores commentOnPullRequest without the @review-agent prefix', async () => {
    const { queue, enqueue } = makeQueue();
    const envelope = makeEnvelope({
      Message: eventBridgeMessage({
        event: 'commentOnPullRequest',
        pullRequestId: '9',
        repositoryName: 'repo-d',
        commentContent: 'looks good',
      }),
    });
    const r = await handleCodecommitWebhook(ctx, envelope, { queue });
    expect(r.kind).toBe('ignored');
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('ignores a Notification with malformed (non-JSON) Message body', async () => {
    const { queue, enqueue } = makeQueue();
    const envelope = makeEnvelope({ Message: 'not-json' });
    const r = await handleCodecommitWebhook(ctx, envelope, { queue });
    expect(r.kind).toBe('ignored');
    expect(r).toMatchObject({ reason: expect.stringContaining('malformed') });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('ignores a Notification with an empty Message', async () => {
    const { queue } = makeQueue();
    const envelope = makeEnvelope({ Message: '' });
    const r = await handleCodecommitWebhook(ctx, envelope, { queue });
    expect(r.kind).toBe('ignored');
  });

  it('ignores an unhandled codecommit event type', async () => {
    const { queue, enqueue } = makeQueue();
    const envelope = makeEnvelope({
      Message: eventBridgeMessage({
        event: 'pullRequestMergeStatusUpdated',
        pullRequestId: '1',
        repositoryName: 'r',
      }),
    });
    const r = await handleCodecommitWebhook(ctx, envelope, { queue });
    expect(r.kind).toBe('ignored');
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('ignores PR events missing repositoryName / pullRequestId', async () => {
    const { queue, enqueue } = makeQueue();
    const envelope = makeEnvelope({
      Message: eventBridgeMessage({ event: 'pullRequestCreated' }),
    });
    const r = await handleCodecommitWebhook(ctx, envelope, { queue });
    expect(r.kind).toBe('ignored');
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('accepts a flat (non-EventBridge) Message payload', async () => {
    const { queue, enqueue } = makeQueue();
    const envelope = makeEnvelope({
      Message: JSON.stringify({
        event: 'pullRequestCreated',
        pullRequestId: '5',
        repositoryNames: ['repo-flat'],
      }),
    });
    const r = await handleCodecommitWebhook(ctx, envelope, { queue });
    expect(r.kind).toBe('enqueued');
    expect(enqueue.mock.calls[0]?.[0].prRef.repo).toBe('repo-flat');
  });

  it('rejects an invalid pullRequestId (non-numeric string)', async () => {
    const { queue, enqueue } = makeQueue();
    const envelope = makeEnvelope({
      Message: eventBridgeMessage({
        event: 'pullRequestCreated',
        pullRequestId: 'not-a-number',
        repositoryName: 'r',
      }),
    });
    const r = await handleCodecommitWebhook(ctx, envelope, { queue });
    expect(r.kind).toBe('ignored');
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('rejects a non-string event field', async () => {
    const { queue } = makeQueue();
    const envelope = makeEnvelope({
      Message: JSON.stringify({ detail: { event: 42, pullRequestId: '1', repositoryName: 'r' } }),
    });
    const r = await handleCodecommitWebhook(ctx, envelope, { queue });
    expect(r.kind).toBe('ignored');
  });
});
