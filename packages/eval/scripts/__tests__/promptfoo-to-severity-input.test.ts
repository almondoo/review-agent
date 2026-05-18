import { describe, expect, it } from 'vitest';
import { buildScoringInput, fixtureIdFromDiff } from '../promptfoo-to-severity-input.js';

describe('fixtureIdFromDiff', () => {
  it('extracts the canonical id from a typical file:// path', () => {
    expect(
      fixtureIdFromDiff('file://fixtures/severity-calibration/01-sql-injection-critical/diff.txt'),
    ).toBe('01-sql-injection-critical');
  });

  it('returns null for absent diff', () => {
    expect(fixtureIdFromDiff(undefined)).toBeNull();
  });

  it('returns null when the path does not include severity-calibration', () => {
    expect(fixtureIdFromDiff('file://fixtures/golden/04-foo/diff.txt')).toBeNull();
  });
});

describe('buildScoringInput', () => {
  const rowFor = (id: string, severity: 'info' | 'minor' | 'major' | 'critical') => ({
    vars: { diff: `file://fixtures/severity-calibration/${id}/diff.txt` },
    response: { output: { comments: [{ severity }] } },
  });

  it('groups runs by fixture id (new-style results.results envelope)', () => {
    const raw = {
      results: {
        results: [
          rowFor('01-sql-injection-critical', 'critical'),
          rowFor('01-sql-injection-critical', 'major'),
          rowFor('05-magic-number-minor', 'minor'),
        ],
      },
    };
    const out = buildScoringInput(raw);
    expect(out.results).toHaveLength(2);
    const sql = out.results.find((r) => r.fixtureId === '01-sql-injection-critical');
    expect(sql?.runs).toHaveLength(2);
    expect(sql?.runs[0]?.comments[0]?.severity).toBe('critical');
    expect(sql?.runs[1]?.comments[0]?.severity).toBe('major');
  });

  it('parses the response.output when it is a JSON string', () => {
    const raw = {
      results: {
        results: [
          {
            vars: { diff: 'file://fixtures/severity-calibration/06-debug-log-info/diff.txt' },
            response: { output: JSON.stringify({ comments: [{ severity: 'info' }] }) },
          },
        ],
      },
    };
    const out = buildScoringInput(raw);
    expect(out.results[0]?.runs[0]?.comments[0]?.severity).toBe('info');
  });

  it('falls back to top-level output (older promptfoo shape)', () => {
    const raw = {
      results: {
        results: [
          {
            vars: { diff: 'file://fixtures/severity-calibration/04-off-by-one-major/diff.txt' },
            output: { comments: [{ severity: 'major' }] },
          },
        ],
      },
    };
    const out = buildScoringInput(raw);
    expect(out.results[0]?.fixtureId).toBe('04-off-by-one-major');
    expect(out.results[0]?.runs[0]?.comments[0]?.severity).toBe('major');
  });

  it('handles flat top-level results array (legacy shape)', () => {
    const raw = {
      flatResults: [rowFor('03-missing-await-major', 'major')],
    };
    const out = buildScoringInput(raw);
    expect(out.results).toHaveLength(1);
    expect(out.results[0]?.fixtureId).toBe('03-missing-await-major');
  });

  it('drops rows without a fixture id (unrelated tests in the run)', () => {
    const raw = {
      results: {
        results: [
          rowFor('02-path-traversal-critical', 'critical'),
          { vars: { diff: 'file://fixtures/golden/xx/diff.txt' }, output: { comments: [] } },
        ],
      },
    };
    const out = buildScoringInput(raw);
    expect(out.results).toHaveLength(1);
    expect(out.results[0]?.fixtureId).toBe('02-path-traversal-critical');
  });

  it('emits empty comments array when the response cannot be parsed', () => {
    const raw = {
      results: {
        results: [
          {
            vars: { diff: 'file://fixtures/severity-calibration/05-magic-number-minor/diff.txt' },
            response: { output: 'this is not JSON' },
          },
        ],
      },
    };
    const out = buildScoringInput(raw);
    expect(out.results[0]?.runs[0]?.comments).toEqual([]);
  });
});
