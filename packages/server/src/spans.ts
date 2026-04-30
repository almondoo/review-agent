import { type Span, SpanStatusCode, trace } from '@opentelemetry/api';

const TRACER_NAME = 'review-agent';

export type SpanName =
  | 'webhook'
  | 'job'
  | 'clone'
  | 'secret_scan'
  | 'llm.call'
  | 'llm.tool'
  | 'comment.post';

export type SpanAttributes = {
  readonly [key: string]: string | number | boolean | undefined;
};

// Wraps an async function in an OTel span with the spec §13.1 hierarchy
// names. Errors are recorded; the span ends in either case. Returns the
// wrapped function's result.
export async function withSpan<T>(
  name: SpanName,
  attrs: SpanAttributes,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  const tracer = trace.getTracer(TRACER_NAME);
  return tracer.startActiveSpan(name, async (span) => {
    setAttrs(span, attrs);
    try {
      const out = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return out;
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
      throw err;
    } finally {
      span.end();
    }
  });
}

function setAttrs(span: Span, attrs: SpanAttributes): void {
  for (const [key, value] of Object.entries(attrs)) {
    if (value !== undefined) span.setAttribute(key, value);
  }
}
