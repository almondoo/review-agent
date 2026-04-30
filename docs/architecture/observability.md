# Observability — OpenTelemetry + Langfuse

Spec references: §13.1 (span hierarchy), §13.2 (metrics), §13.3 (Langfuse).

## What this gives you

- **Distributed tracing** for every webhook → job → review pipeline using
  OpenTelemetry spans (`webhook`, `job`, `clone`, `secret_scan`, `llm.call`,
  `llm.tool`, `comment.post`).
- **Metrics** for SLO + cost dashboards: `review_agent_reviews_total`,
  `…_comments_posted_total`, `…_cost_usd_total`, `…_rate_limit_hits_total`,
  `…_prompt_injection_blocked_total`, `…_incremental_skipped_lines_total`,
  `…_latency_seconds`.
- **Langfuse-compatible** export for LLM call inspection (when bodies are
  explicitly opted into).
- **Body redaction by default** so PR diffs, prompts, completions, and tool
  bodies do not leave the process unless an operator opts in.

The Hono server in `@review-agent/server` is the integration point. The
runner emits attributes the SDK consumes; you do not need to wrap your
own code in spans except where you add new external-facing operations.

## Wiring telemetry on boot

```ts
import { startTelemetry } from '@review-agent/server';

const telemetry = startTelemetry({
  env: {
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT,
    OTEL_EXPORTER_OTLP_HEADERS: process.env.OTEL_EXPORTER_OTLP_HEADERS,
    LANGFUSE_LOG_BODIES: process.env.LANGFUSE_LOG_BODIES,
    NODE_ENV: process.env.NODE_ENV,
  },
  serviceVersion: process.env.REVIEW_AGENT_VERSION,
});

// On Lambda: invoke this from the cold-start path before the handler
// returns control. On long-running Node: shut down on SIGTERM.
process.once('SIGTERM', () => {
  telemetry.shutdown().catch(() => undefined);
});
```

`startTelemetry` registers a global `TracerProvider`. After this call, any
code reaching for `trace.getTracer(...)` gets the configured pipeline.

## Recommended exporter destinations

| Backend | `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | `OTEL_EXPORTER_OTLP_HEADERS` |
|---|---|---|
| Langfuse Cloud | `https://cloud.langfuse.com/api/public/otel/v1/traces` | `Authorization=Basic <base64(public:secret)>` |
| Langfuse self-host | `https://<host>/api/public/otel/v1/traces` | same as cloud |
| Honeycomb | `https://api.honeycomb.io/v1/traces` | `x-honeycomb-team=<key>` |
| Grafana Tempo (OTLP) | `https://tempo-prod-...grafana.net/otlp/v1/traces` | `Authorization=Basic <key>` |
| Local Jaeger / Tempo | `http://localhost:4318/v1/traces` | unset |

The OTLP HTTP exporter sends protobuf over HTTPS and works with any backend
that speaks OTLP. The values above are accurate at the time of writing —
verify your provider's current ingest URL before pasting these into prod.

## Body redaction

Span attributes carry the *summary* of an LLM call (model, token counts,
cost USD, repo, PR number, diff strategy, ...). They do **not** carry the
prompt, completion, tool input/output bodies, or raw diff text by default.

The `BodyRedactionProcessor` strips these keys before export when the
operator has not opted in:

- `llm.input.messages`
- `llm.output.completion`
- `llm.input.prompt`
- `tool.input.body`
- `tool.output.body`

Set `LANGFUSE_LOG_BODIES=1` on the process to keep them. Treat this as a
deliberate operational choice — Langfuse's value depends on bodies, but
the bodies contain the customer's source code. Document the decision in
your runbook before flipping it on.

## Spans

| Span | When | Required attributes |
|---|---|---|
| `webhook` | Top of the webhook handler. Wraps signature verify + idempotency + enqueue. | `review.repo`, `webhook.event` |
| `job` | Worker job processing one review. Parent of every downstream call. | `review.repo`, `review.pr_number`, `review.installation_id` |
| `clone` | Sparse-checkout into the workspace. | `review.repo`, `clone.duration_ms` |
| `secret_scan` | gitleaks pass over the workspace before any LLM call. | `review.repo` |
| `llm.call` | One model invocation. Token / cost attrs land here. | `llm.model`, `llm.input_tokens`, `llm.output_tokens`, `llm.cost_usd` |
| `llm.tool` | One tool call inside an LLM turn. | `tool.name` |
| `comment.post` | Posting one inline comment back to the VCS. | `review.repo`, `review.pr_number`, `comment.severity` |

Use `withSpan(name, attrs, fn)` from `@review-agent/server` to wrap any new
external-facing async operation. Errors are auto-recorded (`exception`
event + `ERROR` status), so you only need to throw.

## Metrics

```ts
import { getMetrics } from '@review-agent/server';

const metrics = getMetrics();
metrics.reviewsTotal.add(1, { status: 'completed', repo: 'owner/repo' });
metrics.commentsPostedTotal.add(3, { severity: 'must_fix' });
metrics.costUsdTotal.add(0.12, { model: 'claude-sonnet-4-6', installation: '12345' });
metrics.latencySecondsHistogram.record(elapsedSec, { phase: 'job' });
```

The instrument set is a singleton; the first call lazily binds against the
global meter provider so it works whether or not telemetry is active.
Unrecorded labels are dropped at export time by the backend.

## Local development

For local end-to-end debugging, run a Jaeger or Grafana Tempo container
and point the exporter at it:

```bash
docker run --rm -p 4318:4318 -p 16686:16686 \
  -e COLLECTOR_OTLP_ENABLED=true \
  jaegertracing/all-in-one:1.59

OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://localhost:4318/v1/traces \
  pnpm --filter @review-agent/server dev
```

Spans appear in the Jaeger UI at `http://localhost:16686/` under the
`review-agent` service.

## Production checklist

- [ ] OTLP endpoint reachable from the deployment's egress (Lambda VPC,
      EC2 security group, etc.).
- [ ] OTLP headers reference a secret manager value, not a literal token.
- [ ] `LANGFUSE_LOG_BODIES` documented as off (default) or on (with the
      reason — typically dev / staging only).
- [ ] Latency histogram alerts wired in your dashboard, with the
      `phase` dimension surfaced.
- [ ] Cost histogram alerts wired (`review_agent_cost_usd_total`) per
      installation, so a runaway agent does not silently burn budget.
- [ ] Error rate alert on `review_agent_reviews_total{status="failed"}`.
