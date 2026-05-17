import { describe, expect, it } from 'vitest';
import {
  AUTO_FETCH_MAX_BYTES_PER_FILE,
  AUTO_FETCH_MAX_FILES,
  AUTO_FETCH_MAX_TOTAL_BYTES,
  BODY_MAX,
  COMMENTS_MAX,
  LINE_MAX,
  MAX_FILE_SIZE,
  MAX_GREP_PATTERN_LENGTH,
  MODEL_NAME_MAX,
  MODEL_NAME_MIN,
  PATH_MAX,
  RULE_ID_MAX,
  RULE_ID_MIN,
  SUGGESTION_MAX,
  SUMMARY_MAX,
} from './limits.js';

describe('limits — schema caps', () => {
  // These values appear verbatim in the spec (§13 InlineComment) and
  // are the contract that downstream packages bind against. A change
  // here is a behavior change; the test pins the exact numbers so the
  // commit diff makes that visible.
  it('pins ReviewOutput / ReviewState numeric caps', () => {
    expect(PATH_MAX).toBe(500);
    expect(BODY_MAX).toBe(5_000);
    expect(SUGGESTION_MAX).toBe(5_000);
    expect(SUMMARY_MAX).toBe(10_000);
    expect(LINE_MAX).toBe(1_000_000);
    expect(COMMENTS_MAX).toBe(50);
    expect(MODEL_NAME_MIN).toBe(1);
    expect(MODEL_NAME_MAX).toBe(128);
    expect(RULE_ID_MIN).toBe(2);
    expect(RULE_ID_MAX).toBe(64);
  });
});

describe('limits — runner tool caps', () => {
  it('pins read_file and grep limits at their existing values', () => {
    expect(MAX_FILE_SIZE).toBe(1_000_000);
    expect(MAX_GREP_PATTERN_LENGTH).toBe(200);
  });
});

describe('limits — auto-fetch budget', () => {
  it('matches the spec §15 path_instructions.auto_fetch defaults', () => {
    expect(AUTO_FETCH_MAX_FILES).toBe(5);
    expect(AUTO_FETCH_MAX_BYTES_PER_FILE).toBe(50_000);
    expect(AUTO_FETCH_MAX_TOTAL_BYTES).toBe(250_000);
  });

  it('enforces a per-file cap <= total cap (otherwise the per-file cap is dead)', () => {
    expect(AUTO_FETCH_MAX_BYTES_PER_FILE).toBeLessThanOrEqual(AUTO_FETCH_MAX_TOTAL_BYTES);
  });
});

describe('limits — invariants', () => {
  // Catch any future tuning that accidentally flips a bound past its
  // partner. None of these are spec text, just structural sanity
  // checks so a typo (e.g. min > max) cannot ship green.
  it('every *_MIN is strictly less than the matching *_MAX', () => {
    expect(MODEL_NAME_MIN).toBeLessThan(MODEL_NAME_MAX);
    expect(RULE_ID_MIN).toBeLessThan(RULE_ID_MAX);
  });

  it('every limit is a positive integer', () => {
    const all = [
      PATH_MAX,
      BODY_MAX,
      SUGGESTION_MAX,
      SUMMARY_MAX,
      LINE_MAX,
      COMMENTS_MAX,
      MODEL_NAME_MIN,
      MODEL_NAME_MAX,
      RULE_ID_MIN,
      RULE_ID_MAX,
      MAX_FILE_SIZE,
      MAX_GREP_PATTERN_LENGTH,
      AUTO_FETCH_MAX_FILES,
      AUTO_FETCH_MAX_BYTES_PER_FILE,
      AUTO_FETCH_MAX_TOTAL_BYTES,
    ];
    for (const n of all) {
      expect(Number.isInteger(n)).toBe(true);
      expect(n).toBeGreaterThan(0);
    }
  });
});
