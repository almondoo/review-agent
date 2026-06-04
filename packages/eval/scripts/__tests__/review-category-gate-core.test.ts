import { describe, expect, it } from 'vitest';
import {
  type ActualFinding,
  aggregateCategoryScores,
  type CategoryBaseline,
  CategoryBaselineSchema,
  type CategoryExpected,
  type CategoryScore,
  checkCategoryGate,
  findingMatches,
  REVIEW_CATEGORIES,
  type ReviewCategory,
  renderGateReport,
  scoreFixture,
} from '../review-category-gate-core.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeExpected(
  override: Partial<CategoryExpected> & Pick<CategoryExpected, 'review_category'>,
): CategoryExpected {
  return {
    bug_class: 'test-bug',
    language: 'TypeScript',
    rationale: 'test rationale',
    expected_findings: [
      {
        id: 'finding-1',
        must_contain_any: ['SQL injection', 'parameteriz'],
      },
    ],
    ...override,
  };
}

function makeActual(body: string): ActualFinding {
  return { body };
}

function makeBaseline(
  perCategory: Partial<Record<ReviewCategory, { precision: number | null; recall: number | null }>>,
  thresholdOverrides: Partial<
    Record<ReviewCategory, { precision_drop_max?: number; recall_drop_max?: number }>
  > = {},
): CategoryBaseline {
  const defaultMetrics = { precision: null, recall: null };
  const perCategoryFull: Record<
    ReviewCategory,
    { precision: number | null; recall: number | null }
  > = {
    security: defaultMetrics,
    performance: defaultMetrics,
    style: defaultMetrics,
    tests: defaultMetrics,
    correctness: defaultMetrics,
    ...perCategory,
  };
  const defaultThreshold = { precision_drop_max: 0.05, recall_drop_max: 0.05 };
  const perCategoryThresholds: Record<
    ReviewCategory,
    { precision_drop_max: number; recall_drop_max: number }
  > = {
    security: defaultThreshold,
    performance: defaultThreshold,
    style: defaultThreshold,
    tests: defaultThreshold,
    correctness: defaultThreshold,
  };
  for (const cat of REVIEW_CATEGORIES) {
    const override = thresholdOverrides[cat];
    if (override) {
      perCategoryThresholds[cat] = {
        precision_drop_max: override.precision_drop_max ?? 0.05,
        recall_drop_max: override.recall_drop_max ?? 0.05,
      };
    }
  }
  return CategoryBaselineSchema.parse({
    version: 1,
    thresholds: {
      default_precision_drop_max: 0.05,
      default_recall_drop_max: 0.05,
      per_category: perCategoryThresholds,
    },
    current: {
      pending_measurement: true,
      per_category: perCategoryFull,
    },
    history: [],
  });
}

// ---------------------------------------------------------------------------
// findingMatches
// ---------------------------------------------------------------------------

describe('findingMatches', () => {
  it('returns true when a plain-string pattern appears in the body (case-insensitive)', () => {
    const ef = { id: 'f1', must_contain_any: ['SQL injection'] };
    expect(findingMatches(ef, 'This introduces an SQL injection risk.')).toBe(true);
    expect(findingMatches(ef, 'sql INJECTION vulnerability')).toBe(true);
  });

  it('returns false when no pattern matches', () => {
    const ef = { id: 'f1', must_contain_any: ['SQL injection', 'parameteriz'] };
    expect(findingMatches(ef, 'Memory allocation is slow.')).toBe(false);
  });

  it('supports regex patterns with word boundaries', () => {
    const ef = { id: 'f1', must_contain_any: ['off.?by.?one'] };
    expect(findingMatches(ef, 'off-by-one error in loop')).toBe(true);
    expect(findingMatches(ef, 'off by one')).toBe(true);
    expect(findingMatches(ef, 'offbyone index')).toBe(true);
  });

  it('falls back to substring match when regex pattern is invalid', () => {
    // Pattern that is not a valid regex (unbalanced parenthesis)
    const ef = { id: 'f1', must_contain_any: ['(bad regex'] };
    expect(findingMatches(ef, '(bad regex in body')).toBe(true);
    expect(findingMatches(ef, 'something else')).toBe(false);
  });

  it('returns true when any of multiple patterns matches', () => {
    const ef = { id: 'f1', must_contain_any: ['nope', 'SQL injection', 'also-nope'] };
    expect(findingMatches(ef, 'SQL injection vector detected')).toBe(true);
  });

  it('returns false on empty body', () => {
    const ef = { id: 'f1', must_contain_any: ['SQL injection'] };
    expect(findingMatches(ef, '')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// scoreFixture
// ---------------------------------------------------------------------------

describe('scoreFixture', () => {
  it('truePositives = 1 when actual finding body matches the expected pattern', () => {
    const expected = makeExpected({ review_category: 'security' });
    const actual = [makeActual('This is an SQL injection vulnerability.')];
    const score = scoreFixture(expected, actual, 'security/sql');
    expect(score.truePositives).toBe(1);
    expect(score.matched).toContain('finding-1');
    expect(score.missed).toHaveLength(0);
  });

  it('truePositives = 0 when no actual finding matches', () => {
    const expected = makeExpected({ review_category: 'security' });
    const actual = [makeActual('This is fine, no issues here.')];
    const score = scoreFixture(expected, actual, 'security/sql');
    expect(score.truePositives).toBe(0);
    expect(score.missed).toContain('finding-1');
    expect(score.matched).toHaveLength(0);
  });

  it('counts actualCount correctly', () => {
    const expected = makeExpected({ review_category: 'performance' });
    const actual = [makeActual('issue 1'), makeActual('issue 2'), makeActual('issue 3')];
    const score = scoreFixture(expected, actual, 'perf/test');
    expect(score.actualCount).toBe(3);
  });

  it('handles empty actual findings (recall miss, zero precision denominator)', () => {
    const expected = makeExpected({ review_category: 'correctness' });
    const score = scoreFixture(expected, [], 'correctness/test');
    expect(score.truePositives).toBe(0);
    expect(score.actualCount).toBe(0);
    expect(score.missed).toContain('finding-1');
  });

  it('handles multiple expected findings — only some matched', () => {
    const expected = makeExpected({
      review_category: 'security',
      expected_findings: [
        { id: 'f1', must_contain_any: ['hardcoded'] },
        { id: 'f2', must_contain_any: ['path traversal'] },
      ],
    });
    const actual = [makeActual('A hardcoded password was found.')];
    const score = scoreFixture(expected, actual, 'security/mixed');
    expect(score.truePositives).toBe(1);
    expect(score.matched).toContain('f1');
    expect(score.missed).toContain('f2');
    expect(score.expectedCount).toBe(2);
  });

  it('a single actual finding satisfying two different expected findings counts each separately', () => {
    const expected = makeExpected({
      review_category: 'security',
      expected_findings: [
        { id: 'f1', must_contain_any: ['SQL injection'] },
        { id: 'f2', must_contain_any: ['parameteriz'] },
      ],
    });
    // "parameterized" triggers both patterns on the same body
    const actual = [makeActual('SQL injection via unparameterized query.')];
    const score = scoreFixture(expected, actual, 'security/multi');
    expect(score.truePositives).toBe(2);
    expect(score.matched).toContain('f1');
    expect(score.matched).toContain('f2');
  });
});

// ---------------------------------------------------------------------------
// aggregateCategoryScores — precision / recall
// ---------------------------------------------------------------------------

describe('aggregateCategoryScores', () => {
  it('precision = TP / actual  recall = TP / expected', () => {
    // 1 fixture: 1 expected, 2 actual (1 TP, 1 FP)
    const scores = [
      {
        fixtureId: 'security/test',
        review_category: 'security' as ReviewCategory,
        truePositives: 1,
        expectedCount: 1,
        actualCount: 2,
        matched: ['f1'],
        missed: [],
      },
    ];
    const agg = aggregateCategoryScores(scores);
    const sec = agg.perCategory.get('security');
    expect(sec).toBeDefined();
    // precision = 1/2, recall = 1/1
    expect(sec?.precision).toBeCloseTo(0.5, 4);
    expect(sec?.recall).toBeCloseTo(1.0, 4);
  });

  it('precision = 0 when actual = 0 (no findings emitted)', () => {
    const scores = [
      {
        fixtureId: 'performance/test',
        review_category: 'performance' as ReviewCategory,
        truePositives: 0,
        expectedCount: 1,
        actualCount: 0,
        matched: [],
        missed: ['f1'],
      },
    ];
    const agg = aggregateCategoryScores(scores);
    const perf = agg.perCategory.get('performance');
    expect(perf?.precision).toBe(0);
    expect(perf?.recall).toBe(0);
  });

  it('precision = 1 and recall = 1 when all expected findings matched and no FP', () => {
    const scores = [
      {
        fixtureId: 'correctness/test',
        review_category: 'correctness' as ReviewCategory,
        truePositives: 2,
        expectedCount: 2,
        actualCount: 2,
        matched: ['f1', 'f2'],
        missed: [],
      },
    ];
    const agg = aggregateCategoryScores(scores);
    const cor = agg.perCategory.get('correctness');
    expect(cor?.precision).toBe(1.0);
    expect(cor?.recall).toBe(1.0);
  });

  it('categories with no fixtures have precision=0 and recall=0 and fixtureCount=0', () => {
    const scores = [
      {
        fixtureId: 'style/test',
        review_category: 'style' as ReviewCategory,
        truePositives: 1,
        expectedCount: 1,
        actualCount: 1,
        matched: ['f1'],
        missed: [],
      },
    ];
    const agg = aggregateCategoryScores(scores);
    const tests = agg.perCategory.get('tests');
    expect(tests?.fixtureCount).toBe(0);
    expect(tests?.precision).toBe(0);
    expect(tests?.recall).toBe(0);
  });

  it('aggregates multiple fixtures within the same category', () => {
    // 2 fixtures:
    //   fx1: 1 TP, 1 expected, 1 actual
    //   fx2: 0 TP, 1 expected, 2 actual (2 FP)
    // totals: TP=1, expected=2, actual=3
    // precision = 1/3 ≈ 0.333, recall = 1/2 = 0.5
    const scores = [
      {
        fixtureId: 'security/a',
        review_category: 'security' as ReviewCategory,
        truePositives: 1,
        expectedCount: 1,
        actualCount: 1,
        matched: ['f1'],
        missed: [],
      },
      {
        fixtureId: 'security/b',
        review_category: 'security' as ReviewCategory,
        truePositives: 0,
        expectedCount: 1,
        actualCount: 2,
        matched: [],
        missed: ['f2'],
      },
    ];
    const agg = aggregateCategoryScores(scores);
    const sec = agg.perCategory.get('security');
    expect(sec?.totalTruePositives).toBe(1);
    expect(sec?.totalExpected).toBe(2);
    expect(sec?.totalActual).toBe(3);
    expect(sec?.precision).toBeCloseTo(1 / 3, 3);
    expect(sec?.recall).toBeCloseTo(0.5, 4);
    expect(sec?.fixtureCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// checkCategoryGate
// ---------------------------------------------------------------------------

describe('checkCategoryGate', () => {
  function scoreMap(
    entries: Partial<Record<ReviewCategory, Pick<CategoryScore, 'precision' | 'recall'>>>,
  ): ReadonlyMap<ReviewCategory, CategoryScore> {
    const m = new Map<ReviewCategory, CategoryScore>();
    for (const cat of REVIEW_CATEGORIES) {
      const e = entries[cat] ?? { precision: 1.0, recall: 1.0 };
      m.set(cat, {
        category: cat,
        precision: e.precision,
        recall: e.recall,
        fixtureCount: 1,
        totalExpected: 1,
        totalActual: 1,
        totalTruePositives: 1,
      });
    }
    return m;
  }

  it('ok=true when all categories have null baseline (unmeasured)', () => {
    const baseline = makeBaseline({});
    const current = scoreMap({});
    const gate = checkCategoryGate(current, baseline);
    expect(gate.ok).toBe(true);
    expect(gate.regressions).toHaveLength(0);
    expect(gate.unmeasured).toEqual(
      expect.arrayContaining(REVIEW_CATEGORIES as unknown as ReviewCategory[]),
    );
  });

  it('ok=true when drop is exactly at the threshold (not over)', () => {
    const baseline = makeBaseline({ security: { precision: 0.9, recall: 0.8 } });
    // 0.9 - 0.05 = 0.85 → current 0.85 is exactly at threshold, not over
    const current = scoreMap({ security: { precision: 0.85, recall: 0.8 } });
    const gate = checkCategoryGate(current, baseline);
    expect(gate.ok).toBe(true);
    expect(gate.regressions).toHaveLength(0);
  });

  it('ok=false when precision drop exceeds threshold', () => {
    const baseline = makeBaseline({ security: { precision: 0.9, recall: 0.8 } });
    // 0.9 - 0.84 = 0.06 > 0.05
    const current = scoreMap({ security: { precision: 0.84, recall: 0.8 } });
    const gate = checkCategoryGate(current, baseline);
    expect(gate.ok).toBe(false);
    expect(gate.regressions).toHaveLength(1);
    expect(gate.regressions[0]?.metric).toBe('precision');
    expect(gate.regressions[0]?.category).toBe('security');
  });

  it('ok=false when recall drop exceeds threshold', () => {
    const baseline = makeBaseline({ performance: { precision: 0.8, recall: 0.9 } });
    const current = scoreMap({ performance: { precision: 0.8, recall: 0.84 } });
    const gate = checkCategoryGate(current, baseline);
    expect(gate.ok).toBe(false);
    const r = gate.regressions[0];
    expect(r?.metric).toBe('recall');
    expect(r?.category).toBe('performance');
  });

  it('ok=true when current is higher than baseline (improvement)', () => {
    const baseline = makeBaseline({ correctness: { precision: 0.7, recall: 0.7 } });
    const current = scoreMap({ correctness: { precision: 0.9, recall: 0.9 } });
    const gate = checkCategoryGate(current, baseline);
    expect(gate.ok).toBe(true);
    expect(gate.regressions).toHaveLength(0);
  });

  it('detects regressions in multiple categories simultaneously', () => {
    const baseline = makeBaseline({
      security: { precision: 0.9, recall: 0.9 },
      style: { precision: 0.8, recall: 0.8 },
    });
    const current = scoreMap({
      security: { precision: 0.8, recall: 0.9 }, // precision drop 0.1 > 0.05
      style: { precision: 0.8, recall: 0.7 }, // recall drop 0.1 > 0.05
    });
    const gate = checkCategoryGate(current, baseline);
    expect(gate.ok).toBe(false);
    expect(gate.regressions).toHaveLength(2);
  });

  it('uses per-category threshold overrides', () => {
    const baseline = makeBaseline(
      { tests: { precision: 0.8, recall: 0.8 } },
      { tests: { recall_drop_max: 0.15 } }, // looser recall threshold for tests
    );
    // recall drop = 0.8 - 0.67 = 0.13 < 0.15 → should pass
    const current = scoreMap({ tests: { precision: 0.8, recall: 0.67 } });
    const gate = checkCategoryGate(current, baseline);
    expect(gate.ok).toBe(true);
  });

  it('unmeasured list contains categories with null baseline', () => {
    const baseline = makeBaseline({ security: { precision: 0.9, recall: 0.9 } });
    // All other categories remain null
    const current = scoreMap({});
    const gate = checkCategoryGate(current, baseline);
    // performance, style, tests, correctness are unmeasured
    expect(gate.unmeasured).toContain('performance');
    expect(gate.unmeasured).toContain('style');
    expect(gate.unmeasured).not.toContain('security');
  });
});

// ---------------------------------------------------------------------------
// renderGateReport
// ---------------------------------------------------------------------------

describe('renderGateReport', () => {
  function makeAggResult(entries: Partial<Record<ReviewCategory, Partial<CategoryScore>>> = {}) {
    const perCategory = new Map<ReviewCategory, CategoryScore>();
    for (const cat of REVIEW_CATEGORIES) {
      const override = entries[cat] ?? {};
      perCategory.set(cat, {
        category: cat,
        precision: 1.0,
        recall: 1.0,
        fixtureCount: 3,
        totalExpected: 3,
        totalActual: 3,
        totalTruePositives: 3,
        ...override,
      });
    }
    return { perCategory, perFixture: [] as never[] };
  }

  it('includes GATE: ok when gate passes', () => {
    const result = makeAggResult();
    const gate = { ok: true, regressions: [], unmeasured: [] };
    const report = renderGateReport(result, gate);
    expect(report).toContain('GATE: ok');
    expect(report).not.toContain('REGRESSED');
  });

  it('includes GATE: REGRESSED and regression details when gate fails', () => {
    const result = makeAggResult({ security: { precision: 0.8, recall: 0.9 } });
    const gate = {
      ok: false,
      regressions: [
        {
          category: 'security' as ReviewCategory,
          metric: 'precision' as const,
          current: 0.8,
          baseline: 0.9,
          dropPp: 10,
          maxDropPp: 5,
        },
      ],
      unmeasured: [],
    };
    const report = renderGateReport(result, gate);
    expect(report).toContain('GATE: REGRESSED');
    expect(report).toContain('security');
    expect(report).toContain('precision');
  });

  it('notes unmeasured categories', () => {
    const result = makeAggResult();
    const gate = { ok: true, regressions: [], unmeasured: ['tests', 'style'] as ReviewCategory[] };
    const report = renderGateReport(result, gate);
    expect(report).toContain('Unmeasured categories');
    expect(report).toContain('tests');
    expect(report).toContain('eval:baseline');
  });

  it('lists all five categories in the score block', () => {
    const result = makeAggResult();
    const gate = { ok: true, regressions: [], unmeasured: [] };
    const report = renderGateReport(result, gate);
    for (const cat of REVIEW_CATEGORIES) {
      expect(report).toContain(cat);
    }
  });
});
