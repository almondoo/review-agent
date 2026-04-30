import type { ReviewState } from '@review-agent/core';
import { describe, expect, it } from 'vitest';
import { buildSummaryWithState, formatStateComment, parseStateComment } from './state-comment.js';

const validState: ReviewState = {
  schemaVersion: 1,
  lastReviewedSha: 'abc123',
  baseSha: 'def456',
  reviewedAt: '2026-04-30T10:00:00Z',
  modelUsed: 'claude-sonnet-4-6',
  totalTokens: 12345,
  totalCostUsd: 0.45,
  commentFingerprints: ['a1b2c3', 'd4e5f6'],
};

describe('formatStateComment', () => {
  it('wraps state JSON with the canonical marker', () => {
    const out = formatStateComment(validState);
    expect(out.startsWith('<!-- review-agent-state:')).toBe(true);
    expect(out.endsWith('-->')).toBe(true);
    expect(out).toContain('"lastReviewedSha":"abc123"');
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

  it('returns null when JSON is malformed', () => {
    expect(parseStateComment('<!-- review-agent-state: {broken: json} -->')).toBeNull();
  });

  it('returns null when JSON shape is wrong', () => {
    expect(
      parseStateComment(
        '<!-- review-agent-state: {"schemaVersion": 2, "lastReviewedSha": "x"} -->',
      ),
    ).toBeNull();
  });

  it('tolerates extra whitespace and surrounding text', () => {
    const wrapped = `Some intro\n\n<!--   review-agent-state:   ${JSON.stringify(validState)}   -->\n\nMore text`;
    expect(parseStateComment(wrapped)).toEqual(validState);
  });

  it('parses multiline JSON', () => {
    const multiline = `<!-- review-agent-state:\n${JSON.stringify(validState, null, 2)}\n-->`;
    expect(parseStateComment(multiline)).toEqual(validState);
  });

  it('rejects state with non-string fingerprints', () => {
    const bad = formatStateComment(validState).replace('"a1b2c3"', '42');
    expect(parseStateComment(bad)).toBeNull();
  });

  it('returns null when JSON capture is empty', () => {
    expect(parseStateComment('<!-- review-agent-state:  -->')).toBeNull();
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
