import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { afterAll, describe, expect, it } from 'vitest';
import {
  BODY_ATTR_KEYS,
  BodyRedactionProcessor,
  parseOtlpHeaders,
  startTelemetry,
} from './otel.js';
import { withSpan } from './spans.js';

describe('BodyRedactionProcessor', () => {
  it('redacts body attributes when bodies are not allowed', () => {
    const processor = new BodyRedactionProcessor({ allowBodies: false });
    const attrs: Record<string, unknown> = {
      'llm.input.messages': 'secret prompt',
      'llm.output.completion': 'secret completion',
      'llm.input.prompt': 'secret prompt 2',
      'tool.input.body': 'secret tool in',
      'tool.output.body': 'secret tool out',
      'llm.cost_usd': 0.01,
    };
    processor.onEnd({ attributes: attrs });
    for (const key of BODY_ATTR_KEYS) {
      expect(attrs[key]).toBe('[redacted: set LANGFUSE_LOG_BODIES=1 to capture]');
    }
    expect(attrs['llm.cost_usd']).toBe(0.01);
  });

  it('keeps body attributes when bodies are allowed', () => {
    const processor = new BodyRedactionProcessor({ allowBodies: true });
    const attrs: Record<string, unknown> = {
      'llm.input.messages': 'kept prompt',
    };
    processor.onEnd({ attributes: attrs });
    expect(attrs['llm.input.messages']).toBe('kept prompt');
  });

  it('does nothing when there are no body attributes', () => {
    const processor = new BodyRedactionProcessor({ allowBodies: false });
    const attrs: Record<string, unknown> = { 'llm.cost_usd': 0.5 };
    processor.onEnd({ attributes: attrs });
    expect(attrs).toEqual({ 'llm.cost_usd': 0.5 });
  });

  it('forceFlush and shutdown are no-ops that resolve', async () => {
    const processor = new BodyRedactionProcessor({ allowBodies: false });
    await expect(processor.forceFlush()).resolves.toBeUndefined();
    await expect(processor.shutdown()).resolves.toBeUndefined();
  });
});

describe('BodyRedactionProcessor wired into a real provider', () => {
  // NodeSDK can only register once per process, so we wire the redaction
  // processor into a BasicTracerProvider to exercise the end-to-end flow
  // (span emit → redaction → exporter) deterministically.
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [
      new BodyRedactionProcessor({ allowBodies: false }),
      new SimpleSpanProcessor(exporter),
    ],
  });
  provider.register();

  afterAll(async () => {
    await provider.shutdown();
  });

  it('redacts body attributes on spans emitted through the provider', async () => {
    exporter.reset();
    await withSpan(
      'webhook',
      {
        'llm.input.messages': 'should be redacted',
        'llm.cost_usd': 0.42,
      },
      async () => {
        // no-op
      },
    );

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    const [span] = spans;
    expect(span?.name).toBe('webhook');
    expect(span?.attributes['llm.input.messages']).toBe(
      '[redacted: set LANGFUSE_LOG_BODIES=1 to capture]',
    );
    expect(span?.attributes['llm.cost_usd']).toBe(0.42);
  });
});

describe('startTelemetry', () => {
  it('boots the SDK against the supplied exporter and shuts it down cleanly', async () => {
    // BasicTracerProvider above already owns the global tracer for this
    // process. We spin up startTelemetry just long enough to verify the
    // wiring path and the returned handle, then shut it back down.
    const exporter = new InMemorySpanExporter();
    const handle = startTelemetry({
      env: {
        NODE_ENV: 'test',
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://localhost:0',
        OTEL_EXPORTER_OTLP_HEADERS: 'authorization=Bearer x',
        LANGFUSE_LOG_BODIES: '1',
      },
      traceExporter: exporter,
      serviceVersion: '0.0.0-test',
    });
    expect(typeof handle.shutdown).toBe('function');
    await handle.shutdown();
  });

  it('boots without LANGFUSE_LOG_BODIES (defaults to redaction)', async () => {
    const exporter = new InMemorySpanExporter();
    const handle = startTelemetry({
      env: { NODE_ENV: 'test' },
      traceExporter: exporter,
    });
    await handle.shutdown();
  });

  it('boots without an explicit exporter, building OTLP config from env', async () => {
    // No traceExporter override -> exercises buildExporterConfig +
    // OTLPTraceExporter path. We never emit a span, so no network I/O.
    const handle = startTelemetry({
      env: {
        NODE_ENV: 'test',
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://localhost:0',
        OTEL_EXPORTER_OTLP_HEADERS: 'authorization=Bearer x',
      },
    });
    await handle.shutdown();
  });
});

describe('parseOtlpHeaders', () => {
  it('parses comma-separated key=value pairs', () => {
    expect(parseOtlpHeaders('a=1,b=2')).toEqual({ a: '1', b: '2' });
  });

  it('trims whitespace', () => {
    expect(parseOtlpHeaders('  a = 1 ,b=2 ')).toEqual({ a: '1', b: '2' });
  });

  it('drops malformed entries', () => {
    expect(parseOtlpHeaders('a=1,broken,b=2')).toEqual({ a: '1', b: '2' });
  });

  it('returns undefined for empty / undefined input', () => {
    expect(parseOtlpHeaders(undefined)).toBeUndefined();
    expect(parseOtlpHeaders('')).toBeUndefined();
    expect(parseOtlpHeaders(',,')).toBeUndefined();
  });
});
