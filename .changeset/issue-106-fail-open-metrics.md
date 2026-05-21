---
'@review-agent/server': minor
'@review-agent/runner': minor
---

#106 — OTel metrics for fail-open events.

Four new counters in `@review-agent/server`'s instrument set so the v1.2
fail-open paths become alert-able:

- `review_agent_eval_record_errors_total{provider, model}` — `recordEvalEvent`
  threw (transient DB / OTel exporter failure).
- `review_agent_feedback_rate_limit_drops_total` — `createFeedbackWriter`
  dropped a `FeedbackEvent` because the per-job `maxWritesPerJob` cap was
  reached.
- `review_agent_review_history_pruned_total` — deleted row count per
  `startReviewHistoryCleanup` tick (trend monitoring, zero-count ticks
  suppressed).
- `review_agent_history_reader_errors_total` — `historyReader` threw inside
  the runner (the runner still re-raises; the counter fires *before*
  propagation).

Four default bridge factories — `bridgeEvalRecordErrorsToMetrics`,
`bridgeFeedbackRateLimitToMetrics`, `bridgePrunedRowsToMetrics`,
`bridgeHistoryReaderErrorsToMetrics` — operators can pass straight into
the existing callback hooks (`runReview({onEvalRecordError, onHistoryReaderError})`,
`createFeedbackWriter({onRateLimit})`, `startReviewHistoryCleanup({onPruned})`).

New `onPruned(count: number)` hook on `ReviewHistoryCleanupDeps` and new
`onHistoryReaderError(err: unknown)` hook on `RunReviewDeps` (runner). The
runner re-raises `historyReader` failures unchanged for backwards compatibility;
the hook only adds observability.

See `docs/architecture/observability.md` → "Fail-open counters" for the
default wiring and `docs/operations/slo-playbook.md` for the alerting
thresholds these counters power.
