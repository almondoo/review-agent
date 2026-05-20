import { describe, expect, it } from 'vitest';
import { extractFingerprintMarker, resolveFingerprint } from './feedback-fingerprint-resolver.js';

describe('extractFingerprintMarker', () => {
  it('returns null when the body has no marker', () => {
    expect(extractFingerprintMarker('plain body')).toBeNull();
  });

  it('returns null when the marker is malformed (too short hex)', () => {
    expect(extractFingerprintMarker('hello <!-- fingerprint:abc1 --> bye')).toBeNull();
  });

  it('extracts the fingerprint from a well-formed HTML-comment marker', () => {
    expect(extractFingerprintMarker('look here <!-- fingerprint:abc12345 --> rest of body')).toBe(
      'abc12345',
    );
  });

  it('lowercases the extracted fingerprint for safe matching', () => {
    expect(extractFingerprintMarker('<!-- fingerprint:ABCD1234 -->')).toBe('abcd1234');
  });

  it('tolerates whitespace around the value', () => {
    expect(extractFingerprintMarker('<!--   fingerprint:deadbeef01  -->')).toBe('deadbeef01');
  });
});

describe('resolveFingerprint', () => {
  // -- stub path: until #96 lands, no bot comment ever carries the
  //    marker. We assert the resolver still returns the right answer
  //    via the `<fp_prefix>` route.
  it('returns no_marker_and_no_prefix when there is no marker and no fp_prefix (stub path)', () => {
    const r = resolveFingerprint({
      commentBody: 'parent body without marker',
      knownFingerprints: ['abcd1234deadbeef'],
    });
    expect(r).toEqual({ ok: false, reason: 'no_marker_and_no_prefix' });
  });

  // -- fp_prefix path
  it('resolves a unique prefix match', () => {
    const r = resolveFingerprint({
      commentBody: 'parent body without marker',
      fpPrefix: 'abcd1234',
      knownFingerprints: ['abcd1234deadbeef', 'fedcba9876543210'],
    });
    expect(r).toEqual({
      ok: true,
      fingerprint: 'abcd1234deadbeef',
      source: 'prefix',
    });
  });

  it('reports ambiguous_prefix when 2+ known fingerprints match the prefix', () => {
    const r = resolveFingerprint({
      commentBody: 'parent body',
      fpPrefix: 'abcd',
      knownFingerprints: ['abcd1111deadbeef', 'abcd2222deadbeef'],
    });
    expect(r).toEqual({ ok: false, reason: 'ambiguous_prefix' });
  });

  it('reports no_match when 0 known fingerprints match the prefix', () => {
    const r = resolveFingerprint({
      commentBody: 'parent body',
      fpPrefix: '99999999',
      knownFingerprints: ['abcd1234deadbeef'],
    });
    expect(r).toEqual({ ok: false, reason: 'no_match' });
  });

  it('is case-insensitive on the prefix vs the known fingerprints', () => {
    const r = resolveFingerprint({
      commentBody: 'parent body',
      fpPrefix: 'ABCD1234',
      knownFingerprints: ['abcd1234deadbeef'],
    });
    expect(r).toEqual({
      ok: true,
      fingerprint: 'abcd1234deadbeef',
      source: 'prefix',
    });
  });

  // -- marker path (forward-compatible with #96)
  it('resolves a known fingerprint embedded as an HTML-comment marker', () => {
    const r = resolveFingerprint({
      commentBody: '... bot comment ... <!-- fingerprint:abcd1234deadbeef -->',
      knownFingerprints: ['abcd1234deadbeef', 'fedcba9876543210'],
    });
    expect(r).toEqual({
      ok: true,
      fingerprint: 'abcd1234deadbeef',
      source: 'marker',
    });
  });

  it('falls back to fp_prefix when the marker is present but not in knownFingerprints (defensive)', () => {
    const r = resolveFingerprint({
      commentBody: '<!-- fingerprint:1111111111111111 -->',
      fpPrefix: 'abcd1234',
      knownFingerprints: ['abcd1234deadbeef'],
    });
    expect(r).toEqual({
      ok: true,
      fingerprint: 'abcd1234deadbeef',
      source: 'prefix',
    });
  });

  it('returns no_marker_and_no_prefix when marker is unknown and no prefix is given', () => {
    const r = resolveFingerprint({
      commentBody: '<!-- fingerprint:1111111111111111 -->',
      knownFingerprints: ['abcd1234deadbeef'],
    });
    expect(r).toEqual({ ok: false, reason: 'no_marker_and_no_prefix' });
  });
});
