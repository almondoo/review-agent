import { describe, expect, it } from 'vitest';
import { appendFingerprintMarker, extractFingerprintFromComment } from './comment-fingerprint.js';

describe('appendFingerprintMarker', () => {
  it('appends the marker on its own paragraph by default', () => {
    expect(appendFingerprintMarker('finding text', 'abcdef0123456789')).toBe(
      'finding text\n\n<!-- fingerprint:abcdef0123456789 -->',
    );
  });

  it('preserves a single trailing newline (no double-blank)', () => {
    expect(appendFingerprintMarker('finding text\n', 'abcdef0123456789')).toBe(
      'finding text\n<!-- fingerprint:abcdef0123456789 -->',
    );
  });

  it('is idempotent when the same marker already trails the body', () => {
    const once = appendFingerprintMarker('finding', 'abcdef0123456789');
    expect(appendFingerprintMarker(once, 'abcdef0123456789')).toBe(once);
  });

  it('appends a fresh marker when a different fingerprint already trails', () => {
    const stale = appendFingerprintMarker('finding', 'aaaaaaaa11111111');
    const refreshed = appendFingerprintMarker(stale, 'bbbbbbbb22222222');
    // The reader returns the FIRST match, so a stale leading marker
    // would win — we therefore expect the new marker to follow.
    expect(refreshed).toContain('<!-- fingerprint:aaaaaaaa11111111 -->');
    expect(refreshed).toContain('<!-- fingerprint:bbbbbbbb22222222 -->');
  });

  it('handles multi-line bodies', () => {
    const body = 'line one\nline two\n```ts\ncode\n```';
    const out = appendFingerprintMarker(body, 'feedbeef12345678');
    expect(out).toBe(`${body}\n\n<!-- fingerprint:feedbeef12345678 -->`);
  });
});

describe('extractFingerprintFromComment', () => {
  it('returns null when no marker is present', () => {
    expect(extractFingerprintFromComment('plain body, no marker')).toBeNull();
  });

  it('returns null when the fingerprint is shorter than 8 hex chars', () => {
    expect(extractFingerprintFromComment('<!-- fingerprint:abc1 -->')).toBeNull();
  });

  it('extracts a 16-hex fingerprint', () => {
    expect(
      extractFingerprintFromComment('finding text\n\n<!-- fingerprint:abcdef0123456789 -->'),
    ).toBe('abcdef0123456789');
  });

  it('extracts an 8-hex prefix (matches /feedback fp_prefix argument)', () => {
    expect(extractFingerprintFromComment('foo <!-- fingerprint:deadbeef --> bar')).toBe('deadbeef');
  });

  it('is case-insensitive and lowercases the captured fingerprint', () => {
    expect(extractFingerprintFromComment('<!-- FINGERPRINT:ABCD1234 -->')).toBe('abcd1234');
  });

  it('tolerates extra whitespace inside the marker', () => {
    expect(extractFingerprintFromComment('<!--   fingerprint:deadbeef01  -->')).toBe('deadbeef01');
  });

  it('does not collide with the v0.1 state comment marker', () => {
    // Existing state-comment marker shape — must not be misread as a
    // fingerprint marker even though both are HTML comments.
    expect(
      extractFingerprintFromComment('<!-- review-agent-state:v1 lastReviewedSha=abcdef -->'),
    ).toBeNull();
  });
});
