import { describe, expect, it, vi } from 'vitest';
import { createSqsLambdaHandler } from './lambda-worker.js';

const goodBody = JSON.stringify({
  jobId: 'j',
  installationId: '11',
  prRef: { platform: 'github', owner: 'o', repo: 'r', number: 1 },
  triggeredBy: 'pull_request.opened',
  enqueuedAt: '2026-04-30T00:00:00.000Z',
});

describe('createSqsLambdaHandler', () => {
  it('processes valid records with no failures', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const fn = createSqsLambdaHandler({ handler });
    const r = await fn({
      Records: [{ messageId: 'a', body: goodBody, receiptHandle: 'h' }],
    });
    expect(r).toEqual({ batchItemFailures: [] });
    expect(handler).toHaveBeenCalledOnce();
  });

  it('reports a batch item failure on malformed body', async () => {
    const handler = vi.fn();
    const fn = createSqsLambdaHandler({ handler });
    const r = await fn({
      Records: [{ messageId: 'bad', body: '{not json', receiptHandle: 'h' }],
    });
    expect(r.batchItemFailures).toEqual([{ itemIdentifier: 'bad' }]);
    expect(handler).not.toHaveBeenCalled();
  });

  it('reports a batch item failure when handler throws', async () => {
    const handler = vi.fn().mockRejectedValue(new Error('boom'));
    const fn = createSqsLambdaHandler({ handler });
    const r = await fn({
      Records: [{ messageId: 'bz', body: goodBody, receiptHandle: 'h' }],
    });
    expect(r.batchItemFailures).toEqual([{ itemIdentifier: 'bz' }]);
  });
});
