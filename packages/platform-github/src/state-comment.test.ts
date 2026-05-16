import type { ReviewState } from '@review-agent/core';
import { describe, expect, it, vi } from 'vitest';
import {
  buildSummaryWithState,
  formatStateComment,
  parseStateComment,
  type StateParseEvent,
} from './state-comment.js';

const validState: ReviewState = {
  schemaVersion: 1,
  lastReviewedSha: '0123456789abcdef0123456789abcdef01234567',
  baseSha: 'fedcba9876543210fedcba9876543210fedcba98',
  reviewedAt: '2026-04-30T10:00:00.000Z',
  modelUsed: 'claude-sonnet-4-6',
  totalTokens: 12_345,
  totalCostUsd: 0.45,
  commentFingerprints: ['0123456789abcdef', 'fedcba9876543210'],
};

describe('formatStateComment', () => {
  it('wraps state JSON with the canonical marker', () => {
    const out = formatStateComment(validState);
    expect(out.startsWith('<!-- review-agent-state:')).toBe(true);
    expect(out.endsWith('-->')).toBe(true);
    expect(out).toContain(`"lastReviewedSha":"${validState.lastReviewedSha}"`);
  });
});

describe('parseStateComment', () => {
  it('round-trips formatStateComment', () => {
    const parsed = parseStateComment(formatStateComment(validState));
    expect(parsed).toEqual(validState);
  });

  it('returns null when marker is absent', () => {
    expect(parseStateComment('Just a regular summary, no marker.')).toBeNull();
  });

  it('returns null + emits json_parse_failure on malformed JSON', () => {
    const events: StateParseEvent[] = [];
    const result = parseStateComment('<!-- review-agent-state: {broken: json} -->', (e) =>
      events.push(e),
    );
    expect(result).toBeNull();
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('json_parse_failure');
  });

  it('returns null + emits schema_mismatch when schemaVersion is a future v2', () => {
    const forwardRolled = JSON.stringify({ ...validState, schemaVersion: 2 });
    const onEvent = vi.fn();
    const result = parseStateComment(`<!-- review-agent-state: ${forwardRolled} -->`, onEvent);
    expect(result).toBeNull();
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledWith({
      kind: 'schema_mismatch',
      foundVersion: 2,
      expectedVersion: 1,
    });
  });

  it('returns null + emits validation_failure on invalid SHA', () => {
    const corrupted = JSON.stringify({ ...validState, lastReviewedSha: 'not-a-sha' });
    const events: StateParseEvent[] = [];
    const result = parseStateComment(`<!-- review-agent-state: ${corrupted} -->`, (e) =>
      events.push(e),
    );
    expect(result).toBeNull();
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('validation_failure');
  });

  it('returns null + emits validation_failure on negative totalCostUsd', () => {
    const corrupted = JSON.stringify({ ...validState, totalCostUsd: -1 });
    const onEvent = vi.fn();
    const result = parseStateComment(`<!-- review-agent-state: ${corrupted} -->`, onEvent);
    expect(result).toBeNull();
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent.mock.calls[0]?.[0].kind).toBe('validation_failure');
  });

  it('returns null + emits validation_failure when commentFingerprints is missing', () => {
    const { commentFingerprints: _, ...withoutFingerprints } = validState;
    const corrupted = JSON.stringify(withoutFingerprints);
    const events: StateParseEvent[] = [];
    const result = parseStateComment(`<!-- review-agent-state: ${corrupted} -->`, (e) =>
      events.push(e),
    );
    expect(result).toBeNull();
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('validation_failure');
  });

  it('tolerates extra whitespace and surrounding text', () => {
    const wrapped = `Some intro\n\n<!--   review-agent-state:   ${JSON.stringify(
      validState,
    )}   -->\n\nMore text`;
    expect(parseStateComment(wrapped)).toEqual(validState);
  });

  it('parses multiline JSON', () => {
    const multiline = `<!-- review-agent-state:\n${JSON.stringify(validState, null, 2)}\n-->`;
    expect(parseStateComment(multiline)).toEqual(validState);
  });

  it('returns null when JSON capture is empty', () => {
    expect(parseStateComment('<!-- review-agent-state:  -->')).toBeNull();
  });

  it('returns null without throwing when no event handler is supplied', () => {
    const corrupted = JSON.stringify({ ...validState, totalCostUsd: -1 });
    expect(parseStateComment(`<!-- review-agent-state: ${corrupted} -->`)).toBeNull();
  });
});

describe('buildSummaryWithState', () => {
  it('appends marker after summary text', () => {
    const out = buildSummaryWithState('## Review summary\n\nLooks good.', validState);
    expect(out).toContain('## Review summary');
    expect(out).toContain('<!-- review-agent-state:');
    const parsed = parseStateComment(out);
    expect(parsed).toEqual(validState);
  });
});
