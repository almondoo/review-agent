import { type Counter, type Histogram, type Meter, metrics } from '@opentelemetry/api';

const METER_NAME = 'review-agent';

export type ReviewAgentMetrics = {
  reviewsTotal: Counter<{ status: string; repo: string }>;
  commentsPostedTotal: Counter<{ severity: string }>;
  costUsdTotal: Counter<{ model: string; installation: string }>;
  rateLimitHitsTotal: Counter<{ api: string }>;
  promptInjectionBlockedTotal: Counter<Record<string, string>>;
  incrementalSkippedLinesTotal: Counter<Record<string, string>>;
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
    latencySecondsHistogram: m.createHistogram('review_agent_latency_seconds', {
      description: 'End-to-end latency by phase.',
      unit: 's',
    }),
  };
  return cached;
}

// Test helper: drops the cached metrics so the next getMetrics() call
// rebuilds against the current global meter provider. Production code
// must not call this.
export function _resetMetricsForTest(): void {
  cached = null;
}
