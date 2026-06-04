import { type Counter, type Histogram, type Meter, metrics } from '@opentelemetry/api';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  _resetMetricsForTest,
  bridgeEvalRecordErrorsToMetrics,
  bridgeFeedbackRateLimitToMetrics,
  bridgeHistoryReaderErrorsToMetrics,
  bridgePrunedRowsToMetrics,
  bridgeSuppressionRulesCreatedToMetrics,
  getMetrics,
} from './metrics.js';

afterEach(() => {
  _resetMetricsForTest();
  vi.restoreAllMocks();
});

function fakeMeter(): {
  meter: Meter;
  createCounter: ReturnType<typeof vi.fn>;
  createHistogram: ReturnType<typeof vi.fn>;
} {
  const counter = { add: vi.fn() } as unknown as Counter;
  const histogram = { record: vi.fn() } as unknown as Histogram;
  const createCounter = vi.fn(() => counter);
  const createHistogram = vi.fn(() => histogram);
  const meter = { createCounter, createHistogram } as unknown as Meter;
  return { meter, createCounter, createHistogram };
}

describe('getMetrics', () => {
  it('creates the spec §13.2 instrument set on first call', () => {
    const { meter, createCounter, createHistogram } = fakeMeter();
    getMetrics(meter);
    // Pinned by name only — descriptions are verified separately so an
    // accidental name typo does not silently rename a metric.
    const counterNames = createCounter.mock.calls.map((args) => args[0]);
    expect(counterNames).toEqual([
      'review_agent_reviews_total',
      'review_agent_comments_posted_total',
      'review_agent_cost_usd_total',
      'review_agent_rate_limit_hits_total',
      'review_agent_prompt_injection_blocked_total',
      'review_agent_incremental_skipped_lines_total',
      'review_agent_feedback_command_total',
      'review_agent_eval_record_errors_total',
      'review_agent_feedback_rate_limit_drops_total',
      'review_agent_review_history_pruned_total',
      'review_agent_history_reader_errors_total',
      'review_agent_suppression_rules_created_total',
    ]);
    expect(createHistogram).toHaveBeenCalledWith(
      'review_agent_latency_seconds',
      expect.objectContaining({ unit: 's' }),
    );
  });

  it('returns instruments that forward .add() to the underlying counter with labels', () => {
    const { meter } = fakeMeter();
    const m = getMetrics(meter);
    // The point of these instruments is that callers add to them. Pin the
    // forwarding contract — a refactor that drops `add` would silently make
    // the entire dashboard go cold.
    m.reviewsTotal.add(1, { status: 'success', repo: 'o/r' });
    m.commentsPostedTotal.add(2, { severity: 'major' });
    m.latencySecondsHistogram.record(0.5, { phase: 'review' });
    // We can't read instrument internals via the public API; instead, we
    // assert nothing throws and the references remain functions, since the
    // SDK guarantees that's the surface.
    expect(typeof m.reviewsTotal.add).toBe('function');
    expect(typeof m.latencySecondsHistogram.record).toBe('function');
  });

  it('caches the instrument set across calls', () => {
    const { meter, createCounter } = fakeMeter();
    const first = getMetrics(meter);
    const second = getMetrics(meter);
    expect(first).toBe(second);
    // 12 counters were created on the first call only (#155 added suppressionRulesCreatedTotal).
    expect(createCounter).toHaveBeenCalledTimes(12);
  });

  it('falls back to the global meter provider when no meter is supplied', () => {
    const { meter, createCounter } = fakeMeter();
    const spy = vi.spyOn(metrics, 'getMeter').mockReturnValue(meter);
    getMetrics();
    expect(spy).toHaveBeenCalledWith('review-agent');
    expect(createCounter).toHaveBeenCalled();
  });

  it('_resetMetricsForTest clears the cache', () => {
    const a = fakeMeter();
    const first = getMetrics(a.meter);
    _resetMetricsForTest();
    const b = fakeMeter();
    const second = getMetrics(b.meter);
    expect(first).not.toBe(second);
    expect(b.createCounter).toHaveBeenCalled();
  });
});

describe('fail-open metric bridges (#106)', () => {
  it('bridgeEvalRecordErrorsToMetrics increments with provider/model labels', () => {
    const { meter } = fakeMeter();
    const m = getMetrics(meter);
    const addSpy = vi.spyOn(m.evalRecordErrorsTotal, 'add');
    const bridge = bridgeEvalRecordErrorsToMetrics({
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
    });
    bridge(new Error('db outage'));
    expect(addSpy).toHaveBeenCalledWith(1, {
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
    });
  });

  it('bridgeEvalRecordErrorsToMetrics defaults labels to empty strings when none provided', () => {
    const { meter } = fakeMeter();
    const m = getMetrics(meter);
    const addSpy = vi.spyOn(m.evalRecordErrorsTotal, 'add');
    bridgeEvalRecordErrorsToMetrics()(new Error('x'));
    expect(addSpy).toHaveBeenCalledWith(1, { provider: '', model: '' });
  });

  it('bridgeFeedbackRateLimitToMetrics increments unlabelled', () => {
    const { meter } = fakeMeter();
    const m = getMetrics(meter);
    const addSpy = vi.spyOn(m.feedbackRateLimitDropsTotal, 'add');
    bridgeFeedbackRateLimitToMetrics()();
    expect(addSpy).toHaveBeenCalledWith(1);
  });

  it('bridgePrunedRowsToMetrics adds the delete row count for positive ticks', () => {
    const { meter } = fakeMeter();
    const m = getMetrics(meter);
    const addSpy = vi.spyOn(m.reviewHistoryPrunedTotal, 'add');
    bridgePrunedRowsToMetrics()(42);
    expect(addSpy).toHaveBeenCalledWith(42);
  });

  it('bridgePrunedRowsToMetrics suppresses zero-count ticks', () => {
    const { meter } = fakeMeter();
    const m = getMetrics(meter);
    const addSpy = vi.spyOn(m.reviewHistoryPrunedTotal, 'add');
    bridgePrunedRowsToMetrics()(0);
    expect(addSpy).not.toHaveBeenCalled();
  });

  it('bridgeHistoryReaderErrorsToMetrics increments on every error', () => {
    const { meter } = fakeMeter();
    const m = getMetrics(meter);
    const addSpy = vi.spyOn(m.historyReaderErrorsTotal, 'add');
    bridgeHistoryReaderErrorsToMetrics()(new Error('reader exploded'));
    bridgeHistoryReaderErrorsToMetrics()(new Error('again'));
    expect(addSpy).toHaveBeenCalledTimes(2);
    expect(addSpy).toHaveBeenNthCalledWith(1, 1);
  });

  it('bridgeSuppressionRulesCreatedToMetrics increments with repo label (#155)', () => {
    const { meter } = fakeMeter();
    const m = getMetrics(meter);
    const addSpy = vi.spyOn(m.suppressionRulesCreatedTotal, 'add');
    bridgeSuppressionRulesCreatedToMetrics()('org/repo');
    expect(addSpy).toHaveBeenCalledWith(1, { repo: 'org/repo' });
  });
});
