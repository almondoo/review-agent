import { describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor, escapeLikePattern } from '../cursor.js';

describe('cursor helpers', () => {
  describe('encodeCursor / decodeCursor round-trip', () => {
    it('encodes and decodes correctly', () => {
      const date = new Date('2026-05-01T00:00:00Z');
      const id = BigInt(42);
      const encoded = encodeCursor(date, id);
      const decoded = decodeCursor(encoded);
      expect(decoded).not.toBe(null);
      expect(decoded?.t).toBe(date.toISOString());
      expect(decoded?.id).toBe('42');
    });

    it('handles large bigint IDs', () => {
      const date = new Date('2026-01-01T00:00:00Z');
      const id = BigInt('9007199254740993'); // > Number.MAX_SAFE_INTEGER
      const encoded = encodeCursor(date, id);
      const decoded = decodeCursor(encoded);
      expect(decoded?.id).toBe('9007199254740993');
    });
  });

  describe('decodeCursor', () => {
    it('returns null for random string', () => {
      expect(decodeCursor('not-valid')).toBe(null);
    });

    it('returns null for base64url-encoded non-object JSON', () => {
      const encoded = Buffer.from('"just a string"').toString('base64url');
      expect(decodeCursor(encoded)).toBe(null);
    });

    it('returns null when t field is missing', () => {
      const encoded = Buffer.from(JSON.stringify({ id: '1' })).toString('base64url');
      expect(decodeCursor(encoded)).toBe(null);
    });

    it('returns null when id field is missing', () => {
      const encoded = Buffer.from(JSON.stringify({ t: '2026-01-01T00:00:00Z' })).toString(
        'base64url',
      );
      expect(decodeCursor(encoded)).toBe(null);
    });

    it('returns null when t is not a string', () => {
      const encoded = Buffer.from(JSON.stringify({ t: 12345, id: '1' })).toString('base64url');
      expect(decodeCursor(encoded)).toBe(null);
    });

    it('returns null for invalid base64', () => {
      // Pass something that looks like base64url but decodes to invalid JSON
      expect(decodeCursor('!!invalid!!')).toBe(null);
    });
  });

  describe('escapeLikePattern', () => {
    it('passes through plain text unchanged', () => {
      expect(escapeLikePattern('owner/repo')).toBe('owner/repo');
    });

    it('escapes % so it is treated as a literal', () => {
      expect(escapeLikePattern('100%')).toBe('100\\%');
    });

    it('escapes _ so it is treated as a literal', () => {
      expect(escapeLikePattern('my_repo')).toBe('my\\_repo');
    });

    it('escapes backslash so it is not interpreted as an escape sequence', () => {
      expect(escapeLikePattern('a\\b')).toBe('a\\\\b');
    });

    it('escapes all wildcard characters in combination', () => {
      expect(escapeLikePattern('%_\\special')).toBe('\\%\\_\\\\special');
    });
  });
});
