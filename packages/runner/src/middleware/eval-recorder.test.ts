import type { ReviewEvalEvent } from '@review-agent/core';
import { describe, expect, it, vi } from 'vitest';
import type { RunnerResult } from '../types.js';
import { buildReviewEvalEvent, recordEvalEvent } from './eval-recorder.js';

const ctx = {
  installationId: 42n,
  jobId: 'job-abc',
  repo: 'almondoo/review-agent',
  prNumber: 7,
  headSha: 'deadbeef',
};

function makeResult(overrides: Partial<RunnerResult> = {}): RunnerResult {
  return {
    comments: [],
    summary: 'ok',
    costUsd: 0.1234,
    tokensUsed: { input: 200, output: 50 },
    model: 'claude-sonnet-4-6',
    provider: 'anthropic',
    droppedDuplicates: 0,
    toolCalls: 3,
    reviewEvent: 'COMMENT',
    ...overrides,
  };
}

describe('buildReviewEvalEvent', () => {
  it('produces empty severity / confidence dists when there are no comments', () => {
    const ev = buildReviewEvalEvent(ctx, makeResult(), 1234);
    expect(ev.commentCount).toBe(0);
    expect(ev.severityDist).toEqual({ critical: 0, major: 0, minor: 0, info: 0 });
    expect(ev.confidenceDist).toEqual({ high: 0, medium: 0, low: 0 });
    expect(ev.latencyMs).toBe(1234);
    expect(ev.droppedByFeedback).toBe(0);
    expect(ev.abortReason).toBeNull();
  });

  it('counts severity / confidence buckets across posted comments', () => {
    const result = makeResult({
      comments: [
        {
          path: 'a.ts',
          line: 1,
          side: 'RIGHT',
          severity: 'critical',
          confidence: 'high',
          body: 'x',
          fingerprint: 'a',
        },
        {
          path: 'b.ts',
          line: 2,
          side: 'RIGHT',
          severity: 'major',
          confidence: 'medium',
          body: 'y',
          fingerprint: 'b',
        },
        {
          path: 'c.ts',
          line: 3,
          side: 'RIGHT',
          severity: 'minor',
          // No confidence — runtime treats as 'high' (legacy default).
          body: 'z',
          fingerprint: 'c',
        },
      ],
      droppedDuplicates: 4,
      costUsd: 0.5,
      tokensUsed: { input: 1000, output: 250 },
      toolCalls: 12,
    });
    const ev = buildReviewEvalEvent(ctx, result, 9876);
    expect(ev.commentCount).toBe(3);
    expect(ev.severityDist).toEqual({ critical: 1, major: 1, minor: 1, info: 0 });
    expect(ev.confidenceDist).toEqual({ high: 2, medium: 1, low: 0 });
    expect(ev.droppedDuplicates).toBe(4);
    expect(ev.toolCalls).toBe(12);
    expect(ev.costUsd).toBe(0.5);
    expect(ev.tokensInput).toBe(1000);
    expect(ev.tokensOutput).toBe(250);
  });

  it('forwards aborted.reason into ReviewEvalEvent.abortReason', () => {
    const result = makeResult({
      aborted: { reason: 'max_files_exceeded', internalIssues: [] },
    });
    const ev = buildReviewEvalEvent(ctx, result, 100);
    expect(ev.abortReason).toBe('max_files_exceeded');
  });

  it('keeps abortReason null on the happy path', () => {
    const ev = buildReviewEvalEvent(ctx, makeResult(), 100);
    expect(ev.abortReason).toBeNull();
  });

  it('writes provider / model / repo identity verbatim from the runner result', () => {
    const result = makeResult({ provider: 'openai', model: 'gpt-X' });
    const ev = buildReviewEvalEvent(ctx, result, 0);
    expect(ev.provider).toBe('openai');
    expect(ev.model).toBe('gpt-X');
    expect(ev.repo).toBe('almondoo/review-agent');
    expect(ev.prNumber).toBe(7);
    expect(ev.headSha).toBe('deadbeef');
    expect(ev.installationId).toBe(42n);
  });
});

describe('recordEvalEvent', () => {
  it('forwards the built event to the recorder when no error', async () => {
    const recorder = vi.fn(async () => undefined);
    await recordEvalEvent({ recorder, context: ctx }, makeResult(), 500);
    expect(recorder).toHaveBeenCalledTimes(1);
    const event = recorder.mock.calls[0]?.[0] as ReviewEvalEvent;
    expect(event.jobId).toBe('job-abc');
    expect(event.latencyMs).toBe(500);
  });

  it('is fail-open: recorder errors do not propagate, onRecordError fires once', async () => {
    const boom = new Error('db down');
    const recorder = vi.fn(async () => {
      throw boom;
    });
    const onRecordError = vi.fn();
    await expect(
      recordEvalEvent({ recorder, context: ctx, onRecordError }, makeResult(), 500),
    ).resolves.toBeUndefined();
    expect(onRecordError).toHaveBeenCalledTimes(1);
    expect(onRecordError.mock.calls[0]?.[0]).toBe(boom);
  });

  it('swallows the error silently when onRecordError is not provided', async () => {
    const recorder = vi.fn(async () => {
      throw new Error('nope');
    });
    await expect(
      recordEvalEvent({ recorder, context: ctx }, makeResult(), 1),
    ).resolves.toBeUndefined();
  });
});
