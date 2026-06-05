import { CostExceededError } from '@review-agent/core';
import { describe, expect, it, vi } from 'vitest';
import type { SqsFailureDeps } from './sqs.js';
import { createSqsQueueClient } from './sqs.js';

const baseMsg = {
  jobId: 'j-1',
  installationId: '11',
  prRef: { platform: 'github' as const, owner: 'o', repo: 'r', number: 1 },
  triggeredBy: 'pull_request.opened' as const,
  enqueuedAt: '2026-04-30T00:00:00.000Z',
};

function makeFailureDeps(overrides: Partial<SqsFailureDeps> = {}): SqsFailureDeps {
  return {
    notifier: { dispatch: vi.fn().mockResolvedValue(undefined) },
    vcs: {
      platform: 'github',
      capabilities: {
        clone: true,
        stateComment: 'native',
        approvalEvent: 'github',
        commitMessages: true,
        conversationReply: true,
        committableSuggestions: true,
      },
      getStateComment: vi.fn().mockResolvedValue(null),
      upsertStateComment: vi.fn().mockResolvedValue(undefined),
      getPR: vi.fn(),
      getDiff: vi.fn(),
      getFile: vi.fn(),
      cloneRepo: vi.fn(),
      getExistingComments: vi.fn(),
      postReview: vi.fn(),
      postSummary: vi.fn(),
      postReply: vi.fn(),
    } as unknown as SqsFailureDeps['vcs'],
    logger: {
      error: vi.fn(),
      warn: vi.fn(),
    },
    ...overrides,
  };
}

describe('createSqsQueueClient.enqueue', () => {
  it('sends a SendMessageCommand with JSON body and message attributes', async () => {
    const send = vi.fn().mockResolvedValue({ MessageId: 'm-7' });
    const queue = createSqsQueueClient({
      queueUrl: 'http://q',
      // biome-ignore lint/suspicious/noExplicitAny: SDK mock surface
      client: { send } as any,
    });
    const r = await queue.enqueue(baseMsg);
    expect(r.messageId).toBe('m-7');
    expect(send).toHaveBeenCalledOnce();
    const cmd = send.mock.calls[0]?.[0];
    expect(cmd.input.QueueUrl).toBe('http://q');
    expect(JSON.parse(cmd.input.MessageBody)).toMatchObject({ jobId: 'j-1' });
    expect(cmd.input.MessageAttributes.installationId.StringValue).toBe('11');
  });

  it('rejects invalid messages without calling SQS', async () => {
    const send = vi.fn();
    const queue = createSqsQueueClient({
      queueUrl: 'http://q',
      // biome-ignore lint/suspicious/noExplicitAny: SDK mock surface
      client: { send } as any,
    });
    await expect(
      queue.enqueue({ ...baseMsg, prRef: { ...baseMsg.prRef, number: 0 } }),
    ).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });
});

describe('createSqsQueueClient.dequeue', () => {
  it('processes messages and deletes on success', async () => {
    const calls: { name: string; input: unknown }[] = [];
    const responses = [
      { Messages: [{ MessageId: 'a', ReceiptHandle: 'r1', Body: JSON.stringify(baseMsg) }] },
      { Messages: [] }, // forces loop exit via stopSignal
    ];
    let i = 0;
    const send = vi.fn(async (cmd: { constructor: { name: string }; input: unknown }) => {
      calls.push({ name: cmd.constructor.name, input: cmd.input });
      const r = responses[i++] ?? { Messages: [] };
      return r;
    });
    const ac = new AbortController();
    const queue = createSqsQueueClient({
      queueUrl: 'http://q',
      // biome-ignore lint/suspicious/noExplicitAny: SDK mock surface
      client: { send } as any,
    });
    const handler = vi.fn().mockImplementation(async () => {
      ac.abort();
    });
    await queue.dequeue(handler, { stopSignal: ac.signal, waitTimeSeconds: 0 });
    expect(handler).toHaveBeenCalledOnce();
    expect(calls.some((c) => c.name === 'DeleteMessageCommand')).toBe(true);
  });

  it('skips malformed messages without deleting', async () => {
    const calls: { name: string; input: unknown }[] = [];
    const ac = new AbortController();
    let receiveCalls = 0;
    const send = vi.fn(async (cmd: { constructor: { name: string }; input: unknown }) => {
      calls.push({ name: cmd.constructor.name, input: cmd.input });
      if (cmd.constructor.name === 'ReceiveMessageCommand') {
        receiveCalls += 1;
        if (receiveCalls >= 2) ac.abort();
        if (receiveCalls === 1) {
          return {
            Messages: [{ MessageId: 'a', ReceiptHandle: 'r1', Body: '{not json' }],
          };
        }
      }
      return { Messages: [] };
    });
    const queue = createSqsQueueClient({
      queueUrl: 'http://q',
      // biome-ignore lint/suspicious/noExplicitAny: SDK mock surface
      client: { send } as any,
    });
    const handler = vi.fn();
    await queue.dequeue(handler, { stopSignal: ac.signal, waitTimeSeconds: 0 });
    expect(handler).not.toHaveBeenCalled();
    expect(calls.find((c) => c.name === 'DeleteMessageCommand')).toBeUndefined();
  });

  it('handles an empty ReceiveMessageCommand response (Messages undefined) without invoking the handler', async () => {
    // SQS returns `{ Messages: undefined }` on a long-poll that hits
    // the timeout. The dequeue loop must fall through cleanly — no
    // handler call, no delete — and continue polling until the
    // stopSignal aborts. Covers the `out.Messages ?? []` fallback.
    const ac = new AbortController();
    let receiveCalls = 0;
    const send = vi.fn(async (cmd: { constructor: { name: string } }) => {
      if (cmd.constructor.name === 'ReceiveMessageCommand') {
        receiveCalls += 1;
        if (receiveCalls >= 2) ac.abort();
      }
      return {}; // intentionally omit `Messages`
    });
    const queue = createSqsQueueClient({
      queueUrl: 'http://q',
      // biome-ignore lint/suspicious/noExplicitAny: SDK mock surface
      client: { send } as any,
    });
    const handler = vi.fn();
    await queue.dequeue(handler, { stopSignal: ac.signal, waitTimeSeconds: 0 });
    expect(handler).not.toHaveBeenCalled();
    // The receive must have happened at least twice (loop ran).
    expect(receiveCalls).toBeGreaterThanOrEqual(2);
  });

  it('skips messages missing ReceiptHandle without invoking the handler or deleting', async () => {
    // SQS messages with no ReceiptHandle cannot be deleted; the
    // adapter must skip them rather than call the handler. Covers
    // the `if (!m.Body || !m.ReceiptHandle) continue` branch.
    const calls: { name: string }[] = [];
    const ac = new AbortController();
    let receiveCalls = 0;
    const send = vi.fn(async (cmd: { constructor: { name: string } }) => {
      calls.push({ name: cmd.constructor.name });
      if (cmd.constructor.name === 'ReceiveMessageCommand') {
        receiveCalls += 1;
        if (receiveCalls >= 2) ac.abort();
        if (receiveCalls === 1) {
          return {
            Messages: [{ MessageId: 'a', Body: JSON.stringify(baseMsg) }], // no ReceiptHandle
          };
        }
      }
      return { Messages: [] };
    });
    const queue = createSqsQueueClient({
      queueUrl: 'http://q',
      // biome-ignore lint/suspicious/noExplicitAny: SDK mock surface
      client: { send } as any,
    });
    const handler = vi.fn();
    await queue.dequeue(handler, { stopSignal: ac.signal, waitTimeSeconds: 0 });
    expect(handler).not.toHaveBeenCalled();
    expect(calls.find((c) => c.name === 'DeleteMessageCommand')).toBeUndefined();
  });

  it('returns immediately when stopSignal is already aborted at entry', async () => {
    // The while-loop guard checks `!o.stopSignal?.aborted` at the
    // top of every iteration; an already-aborted signal must yield
    // zero `send` calls.
    const send = vi.fn();
    const queue = createSqsQueueClient({
      queueUrl: 'http://q',
      // biome-ignore lint/suspicious/noExplicitAny: SDK mock surface
      client: { send } as any,
    });
    const ac = new AbortController();
    ac.abort();
    const handler = vi.fn();
    await queue.dequeue(handler, { stopSignal: ac.signal, waitTimeSeconds: 0 });
    expect(send).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it('skips messages with no Body without invoking the handler', async () => {
    // Defense-in-depth: SQS in theory always returns a Body on a
    // valid message, but the SDK type marks it as optional. Covers
    // the `!m.Body` half of the guard.
    const calls: { name: string }[] = [];
    const ac = new AbortController();
    let receiveCalls = 0;
    const send = vi.fn(async (cmd: { constructor: { name: string } }) => {
      calls.push({ name: cmd.constructor.name });
      if (cmd.constructor.name === 'ReceiveMessageCommand') {
        receiveCalls += 1;
        if (receiveCalls >= 2) ac.abort();
        if (receiveCalls === 1) {
          return {
            Messages: [{ MessageId: 'a', ReceiptHandle: 'r1' }], // no Body
          };
        }
      }
      return { Messages: [] };
    });
    const queue = createSqsQueueClient({
      queueUrl: 'http://q',
      // biome-ignore lint/suspicious/noExplicitAny: SDK mock surface
      client: { send } as any,
    });
    const handler = vi.fn();
    await queue.dequeue(handler, { stopSignal: ac.signal, waitTimeSeconds: 0 });
    expect(handler).not.toHaveBeenCalled();
    expect(calls.find((c) => c.name === 'DeleteMessageCommand')).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // #138: transient failure path
  // -------------------------------------------------------------------------

  it('does NOT delete the message on a transient handler failure (allows SQS retry)', async () => {
    // Transient error: the message is left for SQS visibility-timeout
    // retry. No DeleteMessageCommand must be issued.
    const transientErr = Object.assign(new Error('rate limited'), { kind: 'rate_limit' });
    const calls: { name: string }[] = [];
    const ac = new AbortController();
    let receiveCalls = 0;
    const send = vi.fn(async (cmd: { constructor: { name: string } }) => {
      calls.push({ name: cmd.constructor.name });
      if (cmd.constructor.name === 'ReceiveMessageCommand') {
        receiveCalls += 1;
        if (receiveCalls >= 2) ac.abort();
        if (receiveCalls === 1) {
          return {
            Messages: [{ MessageId: 'a', ReceiptHandle: 'r1', Body: JSON.stringify(baseMsg) }],
          };
        }
      }
      return { Messages: [] };
    });
    const failureDeps = makeFailureDeps();
    const queue = createSqsQueueClient({
      queueUrl: 'http://q',
      // biome-ignore lint/suspicious/noExplicitAny: SDK mock surface
      client: { send } as any,
      failureDeps,
    });
    const handler = vi.fn().mockRejectedValue(transientErr);
    await queue.dequeue(handler, { stopSignal: ac.signal, waitTimeSeconds: 0 });
    // No DeleteMessageCommand — message left for SQS to retry.
    expect(calls.find((c) => c.name === 'DeleteMessageCommand')).toBeUndefined();
    // No notification for transient errors.
    expect(failureDeps.notifier.dispatch).not.toHaveBeenCalled();
    expect(failureDeps.vcs.upsertStateComment).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // #138: permanent failure path
  // -------------------------------------------------------------------------

  it('deletes the message on a permanent handler failure (no re-delivery)', async () => {
    const permanentErr = new CostExceededError(1.0, 2.0);
    const calls: { name: string }[] = [];
    const ac = new AbortController();
    let receiveCalls = 0;
    const send = vi.fn(async (cmd: { constructor: { name: string } }) => {
      calls.push({ name: cmd.constructor.name });
      if (cmd.constructor.name === 'ReceiveMessageCommand') {
        receiveCalls += 1;
        if (receiveCalls >= 2) ac.abort();
        if (receiveCalls === 1) {
          return {
            Messages: [{ MessageId: 'a', ReceiptHandle: 'r1', Body: JSON.stringify(baseMsg) }],
          };
        }
      }
      return { Messages: [] };
    });
    const failureDeps = makeFailureDeps();
    const queue = createSqsQueueClient({
      queueUrl: 'http://q',
      // biome-ignore lint/suspicious/noExplicitAny: SDK mock surface
      client: { send } as any,
      failureDeps,
    });
    const handler = vi.fn().mockRejectedValue(permanentErr);
    await queue.dequeue(handler, { stopSignal: ac.signal, waitTimeSeconds: 0 });
    // Message must be deleted (acked) on permanent failure.
    expect(calls.find((c) => c.name === 'DeleteMessageCommand')).toBeDefined();
    // Notification and state comment must have been attempted.
    expect(failureDeps.notifier.dispatch).toHaveBeenCalledOnce();
    expect(failureDeps.vcs.upsertStateComment).toHaveBeenCalledOnce();
    // State comment must carry the FAILED: prefix.
    const [, state] = (failureDeps.vcs.upsertStateComment as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(state.modelUsed).toMatch(/^FAILED:/);
  });

  it('does not delete message on permanent failure when failureDeps absent (backward-compat)', async () => {
    // When no failureDeps are wired, permanent errors are downgraded to
    // transient: no delete, no notification.
    const permanentErr = new CostExceededError(1.0, 2.0);
    const calls: { name: string }[] = [];
    const ac = new AbortController();
    let receiveCalls = 0;
    const send = vi.fn(async (cmd: { constructor: { name: string } }) => {
      calls.push({ name: cmd.constructor.name });
      if (cmd.constructor.name === 'ReceiveMessageCommand') {
        receiveCalls += 1;
        if (receiveCalls >= 2) ac.abort();
        if (receiveCalls === 1) {
          return {
            Messages: [{ MessageId: 'a', ReceiptHandle: 'r1', Body: JSON.stringify(baseMsg) }],
          };
        }
      }
      return { Messages: [] };
    });
    const queue = createSqsQueueClient({
      queueUrl: 'http://q',
      // biome-ignore lint/suspicious/noExplicitAny: SDK mock surface
      client: { send } as any,
      // No failureDeps.
    });
    const handler = vi.fn().mockRejectedValue(permanentErr);
    await queue.dequeue(handler, { stopSignal: ac.signal, waitTimeSeconds: 0 });
    // No deletion — backward-compat path.
    expect(calls.find((c) => c.name === 'DeleteMessageCommand')).toBeUndefined();
  });
});
