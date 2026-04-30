import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { Resource } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';
import {
  SimpleSpanProcessor,
  type SpanExporter,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';

export type OtelEnv = {
  readonly OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?: string;
  readonly OTEL_EXPORTER_OTLP_HEADERS?: string;
  readonly LANGFUSE_LOG_BODIES?: string;
  readonly NODE_ENV?: string;
};

export type StartTelemetryOpts = {
  readonly env: OtelEnv;
  readonly serviceVersion?: string;
  readonly traceExporter?: SpanExporter;
  readonly extraSpanProcessors?: ReadonlyArray<SpanProcessor>;
};

export type TelemetryHandle = {
  shutdown(): Promise<void>;
};

export function startTelemetry(opts: StartTelemetryOpts): TelemetryHandle {
  const { env } = opts;
  const exporter = opts.traceExporter ?? new OTLPTraceExporter(buildExporterConfig(env));

  const processors: SpanProcessor[] = [
    new BodyRedactionProcessor({ allowBodies: env.LANGFUSE_LOG_BODIES === '1' }),
    new SimpleSpanProcessor(exporter),
    ...(opts.extraSpanProcessors ?? []),
  ];

  const sdk = new NodeSDK({
    resource: new Resource({
      [ATTR_SERVICE_NAME]: 'review-agent',
      [ATTR_SERVICE_VERSION]: opts.serviceVersion ?? 'dev',
      'deployment.environment': env.NODE_ENV ?? 'development',
    }),
    spanProcessors: processors,
  });

  sdk.start();
  return {
    shutdown: () => sdk.shutdown(),
  };
}

// Parses an `OTEL_EXPORTER_OTLP_HEADERS` value (`key1=val1,key2=val2`) into
// an OTLP exporter `headers` map. Empty/blank input returns undefined so
// the exporter falls back to its defaults.
export function parseOtlpHeaders(raw: string | undefined): Record<string, string> | undefined {
  if (!raw) return undefined;
  const entries = raw
    .split(',')
    .map((pair) => pair.split('=').map((s) => s.trim()))
    .filter((kv): kv is [string, string] => kv.length === 2 && !!kv[0] && !!kv[1]);
  return entries.length === 0 ? undefined : Object.fromEntries(entries);
}

type OtlpExporterConfig = { url?: string; headers?: Record<string, string> };

function buildExporterConfig(env: OtelEnv): OtlpExporterConfig {
  const config: OtlpExporterConfig = {};
  if (env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT) {
    config.url = env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
  }
  const headers = parseOtlpHeaders(env.OTEL_EXPORTER_OTLP_HEADERS);
  if (headers) config.headers = headers;
  return config;
}

// SpanProcessor that strips body-bearing attributes when bodies are not
// opted into. Span attributes referenced by the spec §13.1 (model,
// input_tokens, output_tokens, cost_usd, repo, pr_number, ...) are kept.
export const BODY_ATTR_KEYS = [
  'llm.input.messages',
  'llm.output.completion',
  'llm.input.prompt',
  'tool.input.body',
  'tool.output.body',
] as const;

export class BodyRedactionProcessor implements SpanProcessor {
  private readonly allowBodies: boolean;

  constructor(opts: { allowBodies: boolean }) {
    this.allowBodies = opts.allowBodies;
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  onStart(): void {
    // no-op
  }

  onEnd(span: { attributes: Record<string, unknown> }): void {
    if (this.allowBodies) return;
    for (const key of BODY_ATTR_KEYS) {
      if (key in span.attributes) {
        span.attributes[key] = '[redacted: set LANGFUSE_LOG_BODIES=1 to capture]';
      }
    }
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}
