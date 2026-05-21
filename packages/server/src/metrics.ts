import { type Counter, type Histogram, type Meter, metrics } from '@opentelemetry/api';

const METER_NAME = 'review-agent';

export type ReviewAgentMetrics = {
  reviewsTotal: Counter<{ status: string; repo: string }>;
  commentsPostedTotal: Counter<{ severity: string }>;
  costUsdTotal: Counter<{ model: string; installation: string }>;
  rateLimitHitsTotal: Counter<{ api: string }>;
  promptInjectionBlockedTotal: Counter<Record<string, string>>;
  incrementalSkippedLinesTotal: Counter<Record<string, string>>;
  /**
   * v1.2 #95: `/feedback` command outcomes by platform + kind +
   * outcome. `outcome ∈ {'recorded', 'unauthorized', 'unresolved',
   * 'rate_limited'}` — see `docs/architecture/feedback-loop.md` for
   * the semantics.
   */
  feedbackCommandTotal: Counter<{ platform: string; kind: string; outcome: string }>;
  /**
   * v1.2 #106: fail-open observability counters. All four track
   * silently-swallowed errors so operators can alert on them; see
   * `docs/architecture/observability.md` and
   * `docs/operations/slo-playbook.md`.
   *
   * - `evalRecordErrorsTotal{provider, model}`: recorder threw during
   *   `recordEvalEvent` (typically transient DB / OTel exporter).
   *   Provider + model are best-effort labels the runner attaches
   *   when calling the bridge; empty strings are valid.
   * - `feedbackRateLimitDropsTotal`: `createFeedbackWriter` dropped a
   *   `FeedbackEvent` because the per-job `maxWritesPerJob` cap was
   *   reached. spec §7.6.
   * - `reviewHistoryPrunedTotal`: rows deleted by
   *   `startReviewHistoryCleanup` (one increment per tick equal to
   *   the deleted row count). Trend monitoring, not error.
   * - `historyReaderErrorsTotal`: `historyReader` threw inside the
   *   runner. The runner re-raises (existing semantic), but the
   *   counter lets operators alert before the cascading review
   *   failure surfaces.
   */
  evalRecordErrorsTotal: Counter<{ provider: string; model: string }>;
  feedbackRateLimitDropsTotal: Counter<Record<string, string>>;
  reviewHistoryPrunedTotal: Counter<Record<string, string>>;
  historyReaderErrorsTotal: Counter<Record<string, string>>;
  latencySecondsHistogram: Histogram<{ phase: string }>;
};

let cached: ReviewAgentMetrics | null = null;

export function getMetrics(meter: Meter | null = null): ReviewAgentMetrics {
  if (cached) return cached;
  const m = meter ?? metrics.getMeter(METER_NAME);
  cached = {
    reviewsTotal: m.createCounter('review_agent_reviews_total', {
      description: 'Reviews completed, partitioned by status and repo.',
    }),
    commentsPostedTotal: m.createCounter('review_agent_comments_posted_total', {
      description: 'Inline comments posted, partitioned by severity.',
    }),
    costUsdTotal: m.createCounter('review_agent_cost_usd_total', {
      description: 'Total LLM cost in USD by model + installation.',
    }),
    rateLimitHitsTotal: m.createCounter('review_agent_rate_limit_hits_total', {
      description: 'Rate-limit responses observed by API.',
    }),
    promptInjectionBlockedTotal: m.createCounter('review_agent_prompt_injection_blocked_total', {
      description: 'Prompt-injection attempts blocked by the runner.',
    }),
    incrementalSkippedLinesTotal: m.createCounter('review_agent_incremental_skipped_lines_total', {
      description: 'Lines skipped because incremental review found no relevant change.',
    }),
    feedbackCommandTotal: m.createCounter('review_agent_feedback_command_total', {
      description: '/feedback command outcomes by platform, kind, and outcome (v1.2 #95).',
    }),
    evalRecordErrorsTotal: m.createCounter('review_agent_eval_record_errors_total', {
      description: 'recordEvalEvent failures (fail-open). v1.2 #106.',
    }),
    feedbackRateLimitDropsTotal: m.createCounter('review_agent_feedback_rate_limit_drops_total', {
      description: 'FeedbackEvents dropped because maxWritesPerJob was reached. v1.2 #106.',
    }),
    reviewHistoryPrunedTotal: m.createCounter('review_agent_review_history_pruned_total', {
      description: 'Rows deleted by startReviewHistoryCleanup per tick (180-day TTL). v1.2 #106.',
    }),
    historyReaderErrorsTotal: m.createCounter('review_agent_history_reader_errors_total', {
      description: 'historyReader threw inside the runner. v1.2 #106.',
    }),
    latencySecondsHistogram: m.createHistogram('review_agent_latency_seconds', {
      description: 'End-to-end latency by phase.',
      unit: 's',
    }),
  };
  return cached;
}

/**
 * v1.2 #106: default bridges that route the fail-open callbacks
 * (`onEvalRecordError`, `onRateLimit`, `onPruned`, `onHistoryReaderError`)
 * to their OTel counters. Operators that want custom behavior can
 * compose: wrap one of these and add their own log line / additional
 * counter increment.
 *
 * The bridges read `getMetrics()` lazily so they are safe to construct
 * before the OTel meter provider is wired up (typical at module load).
 */
export function bridgeEvalRecordErrorsToMetrics(
  attrs: { provider?: string; model?: string } = {},
): (err: unknown) => void {
  return () => {
    getMetrics().evalRecordErrorsTotal.add(1, {
      provider: attrs.provider ?? '',
      model: attrs.model ?? '',
    });
  };
}

export function bridgeFeedbackRateLimitToMetrics(): () => void {
  return () => {
    getMetrics().feedbackRateLimitDropsTotal.add(1);
  };
}

export function bridgePrunedRowsToMetrics(): (count: number) => void {
  return (count) => {
    if (count > 0) {
      getMetrics().reviewHistoryPrunedTotal.add(count);
    }
  };
}

export function bridgeHistoryReaderErrorsToMetrics(): (err: unknown) => void {
  return () => {
    getMetrics().historyReaderErrorsTotal.add(1);
  };
}

// Test helper: drops the cached metrics so the next getMetrics() call
// rebuilds against the current global meter provider. Production code
// must not call this.
export function _resetMetricsForTest(): void {
  cached = null;
}
