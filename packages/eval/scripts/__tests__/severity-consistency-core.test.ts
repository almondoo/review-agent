import { describe, expect, it } from 'vitest';
import {
  aggregateScore,
  checkGate,
  type FixtureExpected,
  modalSeverity,
  primarySeverity,
  SEVERITY_ORDER,
  scoreFixture,
  severityRank,
} from '../severity-consistency-core.js';

const baseExpected: FixtureExpected = {
  category: 'severity-calibration',
  bug_class: 'test',
  language: 'TypeScript',
  severity_min: 'minor',
  severity_max: 'critical',
  severity_modal: 'major',
  rationale: 'unit test',
};

describe('severityRank', () => {
  it('orders info < minor < major < critical', () => {
    expect(severityRank('info')).toBeLessThan(severityRank('minor'));
    expect(severityRank('minor')).toBeLessThan(severityRank('major'));
    expect(severityRank('major')).toBeLessThan(severityRank('critical'));
  });
});

describe('primarySeverity', () => {
  it('returns null on empty', () => {
    expect(primarySeverity([])).toBeNull();
  });

  it('returns highest severity when multiple present', () => {
    expect(
      primarySeverity([{ severity: 'minor' }, { severity: 'critical' }, { severity: 'major' }]),
    ).toBe('critical');
  });

  it('ties broken by first occurrence (semantically: same rank → kept)', () => {
    expect(primarySeverity([{ severity: 'major' }, { severity: 'major' }])).toBe('major');
  });
});

describe('modalSeverity', () => {
  it('returns null when every run is null', () => {
    expect(modalSeverity([null, null, null])).toBeNull();
  });

  it('returns the most-frequent severity', () => {
    expect(modalSeverity(['major', 'major', 'critical'])).toBe('major');
  });

  it('ignores null runs when picking modal', () => {
    expect(modalSeverity(['major', null, 'major'])).toBe('major');
  });

  it('ties broken by SEVERITY_ORDER (lower index wins)', () => {
    // 'minor' (index 1) vs 'major' (index 2) — minor wins.
    expect(modalSeverity(['minor', 'major'])).toBe('minor');
  });
});

describe('scoreFixture', () => {
  it('passes when all 3 runs match modal and lie within range', () => {
    const score = scoreFixture(
      baseExpected,
      { fixtureId: 'x', runs: ['major', 'major', 'major'] },
      0.66,
    );
    expect(score.passed).toBe(true);
    expect(score.stable).toBe(true);
    expect(score.withinRange).toBe(true);
    expect(score.modal).toBe('major');
    expect(score.modalCount).toBe(3);
  });

  it('passes at exactly 2/3 stability', () => {
    const score = scoreFixture(
      baseExpected,
      { fixtureId: 'x', runs: ['major', 'major', 'critical'] },
      0.66,
    );
    expect(score.passed).toBe(true);
  });

  it('fails when stability drops below threshold', () => {
    const score = scoreFixture(
      baseExpected,
      { fixtureId: 'x', runs: ['major', 'critical', 'minor'] },
      0.66,
    );
    expect(score.stable).toBe(false);
    expect(score.passed).toBe(false);
    expect(score.reason).toMatch(/below 0.66 threshold/);
  });

  it('fails when any single run is outside the [min, max] band', () => {
    // 'info' is below the 'minor' floor.
    const score = scoreFixture(
      baseExpected,
      { fixtureId: 'x', runs: ['major', 'major', 'info'] },
      0.66,
    );
    expect(score.withinRange).toBe(false);
    expect(score.passed).toBe(false);
    expect(score.reason).toMatch(/outside \[minor, critical\]/);
  });

  it('fails (with null modal) when any run produced zero comments', () => {
    const score = scoreFixture(
      baseExpected,
      { fixtureId: 'x', runs: ['major', null, 'major'] },
      0.66,
    );
    expect(score.passed).toBe(false);
    expect(score.reason).toContain('zero comments');
  });

  it('fails when fixture has no runs at all', () => {
    const score = scoreFixture(baseExpected, { fixtureId: 'x', runs: [] }, 0.66);
    expect(score.passed).toBe(false);
    expect(score.reason).toBe('no runs');
  });

  it('reports both stability + range failures together', () => {
    const expectedTight: FixtureExpected = {
      ...baseExpected,
      severity_min: 'major',
      severity_max: 'major',
      severity_modal: 'major',
    };
    const score = scoreFixture(
      expectedTight,
      { fixtureId: 'x', runs: ['major', 'critical', 'info'] },
      0.66,
    );
    expect(score.stable).toBe(false);
    expect(score.withinRange).toBe(false);
    expect(score.reason).toMatch(/below/);
    expect(score.reason).toMatch(/outside/);
  });
});

describe('aggregateScore', () => {
  it('computes pass-ratio as the score', () => {
    const agg = aggregateScore([
      {
        fixtureId: 'a',
        modal: 'major',
        modalCount: 3,
        totalRuns: 3,
        stable: true,
        withinRange: true,
        passed: true,
      },
      {
        fixtureId: 'b',
        modal: 'minor',
        modalCount: 1,
        totalRuns: 3,
        stable: false,
        withinRange: true,
        passed: false,
      },
      {
        fixtureId: 'c',
        modal: 'critical',
        modalCount: 3,
        totalRuns: 3,
        stable: true,
        withinRange: true,
        passed: true,
      },
    ]);
    expect(agg.fixturesEvaluated).toBe(3);
    expect(agg.fixturesPassed).toBe(2);
    expect(agg.score).toBeCloseTo(0.6667, 4);
  });

  it('returns score=0 on empty input (no NaN)', () => {
    expect(aggregateScore([]).score).toBe(0);
  });
});

describe('checkGate', () => {
  it('passes when baseline is null (unmeasured)', () => {
    expect(checkGate(0.5, null, 5).ok).toBe(true);
  });

  it('passes when current >= baseline', () => {
    expect(checkGate(0.95, 0.9, 5).ok).toBe(true);
  });

  it('passes when drop is exactly at the threshold', () => {
    // Baseline 95%, current 90% → 5pp drop, equal to limit → still ok.
    expect(checkGate(0.9, 0.95, 5).ok).toBe(true);
  });

  it('fails when drop exceeds the threshold', () => {
    // Baseline 95%, current 89% → 6pp drop.
    const verdict = checkGate(0.89, 0.95, 5);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/dropped 6\.00pp/);
  });

  it('ignores improvements (current > baseline)', () => {
    expect(checkGate(1.0, 0.5, 5).ok).toBe(true);
  });
});

describe('SEVERITY_ORDER constant', () => {
  it('lists exactly the four canonical severities', () => {
    expect(SEVERITY_ORDER).toEqual(['info', 'minor', 'major', 'critical']);
  });
});
