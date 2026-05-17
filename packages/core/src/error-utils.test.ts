import { describe, expect, it } from 'vitest';
import { extractMessage, extractStatus } from './error-utils.js';

describe('extractStatus', () => {
  it('reads a top-level numeric `status`', () => {
    expect(extractStatus({ status: 503 })).toBe(503);
    expect(extractStatus({ status: 200 })).toBe(200);
  });

  it('reads `.response.status` when the top level has none (Octokit/Axios shape)', () => {
    expect(extractStatus({ response: { status: 404 } })).toBe(404);
    expect(extractStatus({ response: { status: 502 } })).toBe(502);
  });

  it('prefers the top-level `status` over the nested response.status', () => {
    expect(extractStatus({ status: 429, response: { status: 500 } })).toBe(429);
  });

  it('returns null for errors with no status field', () => {
    expect(extractStatus(new Error('ECONNRESET'))).toBeNull();
    expect(extractStatus({})).toBeNull();
    expect(extractStatus({ response: {} })).toBeNull();
  });

  it('returns null for non-finite or non-numeric status values', () => {
    expect(extractStatus({ status: '503' })).toBeNull();
    expect(extractStatus({ status: Number.NaN })).toBeNull();
    expect(extractStatus({ status: Number.POSITIVE_INFINITY })).toBeNull();
    expect(extractStatus({ response: { status: '404' } })).toBeNull();
    expect(extractStatus({ response: { status: Number.NaN } })).toBeNull();
  });

  it('returns null for primitives and falsy values', () => {
    expect(extractStatus(null)).toBeNull();
    expect(extractStatus(undefined)).toBeNull();
    expect(extractStatus('error string')).toBeNull();
    expect(extractStatus(42)).toBeNull();
    expect(extractStatus(false)).toBeNull();
  });

  it('returns null when `.response` is itself a non-object (string/null)', () => {
    expect(extractStatus({ response: 'not-an-object' })).toBeNull();
    expect(extractStatus({ response: null })).toBeNull();
  });
});

describe('extractMessage', () => {
  it('returns Error.message for Error instances', () => {
    expect(extractMessage(new Error('boom'))).toBe('boom');
    expect(extractMessage(new TypeError('bad arg'))).toBe('bad arg');
  });

  it('returns the string unchanged for string inputs', () => {
    expect(extractMessage('plain message')).toBe('plain message');
    expect(extractMessage('')).toBe('');
  });

  it('coerces non-Error non-string values via String()', () => {
    expect(extractMessage(42)).toBe('42');
    expect(extractMessage(null)).toBe('null');
    expect(extractMessage(undefined)).toBe('undefined');
    expect(extractMessage({ status: 500 })).toBe('[object Object]');
  });

  it('never throws on cyclic or BigInt inputs (no JSON.stringify dependency)', () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() => extractMessage(cyclic)).not.toThrow();
    expect(() => extractMessage(123n)).not.toThrow();
    // BigInt's String() form is "123", confirming the coercion path.
    expect(extractMessage(123n)).toBe('123');
  });
});
