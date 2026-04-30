import { SpanStatusCode } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withSpan } from './spans.js';

const exporter = new InMemorySpanExporter();
let provider: BasicTracerProvider;

beforeAll(() => {
  provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  provider.register();
});

afterAll(async () => {
  await provider.shutdown();
});

describe('withSpan', () => {
  it('records a span with name + attributes and sets OK status', async () => {
    exporter.reset();
    const out = await withSpan(
      'webhook',
      { 'review.repo': 'o/r', 'review.pr_number': 42 },
      async () => 'ok',
    );
    expect(out).toBe('ok');
    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]?.name).toBe('webhook');
    expect(spans[0]?.attributes['review.repo']).toBe('o/r');
    expect(spans[0]?.attributes['review.pr_number']).toBe(42);
    expect(spans[0]?.status.code).toBe(SpanStatusCode.OK);
  });

  it('records exception + ERROR status and rethrows on failure', async () => {
    exporter.reset();
    await expect(
      withSpan('llm.call', { 'llm.model': 'claude' }, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]?.status.code).toBe(SpanStatusCode.ERROR);
    expect(spans[0]?.status.message).toBe('boom');
    expect(spans[0]?.events.length).toBeGreaterThan(0);
    expect(spans[0]?.events[0]?.name).toBe('exception');
  });

  it('skips undefined attribute values', async () => {
    exporter.reset();
    await withSpan(
      'job',
      { 'review.repo': 'o/r', 'review.optional': undefined },
      async () => undefined,
    );
    const spans = exporter.getFinishedSpans();
    expect(spans[0]?.attributes['review.repo']).toBe('o/r');
    expect(spans[0]?.attributes['review.optional']).toBeUndefined();
  });
});
