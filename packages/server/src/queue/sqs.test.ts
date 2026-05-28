import { describe, expect, it, vi } from 'vitest';
import { createSqsQueueClient } from './sqs.js';

const baseMsg = {
  jobId: 'j-1',
  installationId: '11',
  prRef: { platform: 'github' as const, owner: 'o', repo: 'r', number: 1 },
  triggeredBy: 'pull_request.opened' as const,
  enqueuedAt: '2026-04-30T00:00:00.000Z',
};

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
});
