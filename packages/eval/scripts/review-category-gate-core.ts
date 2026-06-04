// Pure scoring logic for the per-category review-quality regression gate (#143).
//
// All functions are stateless and free of I/O so they are unit-testable
// without a live LLM or disk access (following the severity-consistency-core
// pattern). The CLI wrappers (review-category-gate.ts / review-category-baseline.ts)
// handle all file I/O and process.exit.

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Review categories (spec §14.4 + issue #143)
// ---------------------------------------------------------------------------

export const REVIEW_CATEGORIES = [
  'security',
  'performance',
  'style',
  'tests',
  'correctness',
] as const;
export type ReviewCategory = (typeof REVIEW_CATEGORIES)[number];
export const ReviewCategorySchema = z.enum(REVIEW_CATEGORIES);

// ---------------------------------------------------------------------------
// Expected-findings schema (per-fixture expected.json)
// ---------------------------------------------------------------------------

export const ExpectedFindingSchema = z.object({
  /** Stable identifier unique within the fixture. Used to match against actual findings. */
  id: z.string().min(1),
  /** At least one of these patterns must appear in a candidate finding body for it to count as a hit. */
  must_contain_any: z.array(z.string().min(1)).min(1),
  severity: z.enum(['info', 'minor', 'major', 'critical']).optional(),
});
export type ExpectedFinding = z.infer<typeof ExpectedFindingSchema>;

export const CategoryExpectedSchema = z.object({
  review_category: ReviewCategorySchema,
  bug_class: z.string().min(1),
  language: z.string().min(1),
  expected_findings: z.array(ExpectedFindingSchema),
  rationale: z.string().min(1),
});
export type CategoryExpected = z.infer<typeof CategoryExpectedSchema>;

// ---------------------------------------------------------------------------
// Manifest schema
// ---------------------------------------------------------------------------

export const ManifestEntrySchema = z.object({
  id: z.string().min(1),
  review_category: ReviewCategorySchema,
});
export type ManifestEntry = z.infer<typeof ManifestEntrySchema>;

export const CategoryManifestSchema = z.object({
  version: z.number().int().positive(),
  description: z.string(),
  fixtures: z.array(ManifestEntrySchema).min(1),
});
export type CategoryManifest = z.infer<typeof CategoryManifestSchema>;

// ---------------------------------------------------------------------------
// Actual-findings schema (candidate model output per fixture run)
// ---------------------------------------------------------------------------

export const ActualFindingSchema = z
  .object({
    id: z.string().optional(),
    body: z.string(),
    severity: z.enum(['info', 'minor', 'major', 'critical']).optional(),
    ruleId: z.string().optional(),
  })
  .passthrough();
export type ActualFinding = z.infer<typeof ActualFindingSchema>;

export const FixtureRunSchema = z.object({
  fixtureId: z.string(),
  /** Comments/findings emitted by the candidate reviewer for this fixture. */
  findings: z.array(ActualFindingSchema),
});
export type FixtureRun = z.infer<typeof FixtureRunSchema>;

export const CandidateRunsSchema = z.object({
  results: z.array(FixtureRunSchema),
});
export type CandidateRuns = z.infer<typeof CandidateRunsSchema>;

// ---------------------------------------------------------------------------
// Baseline schema
// ---------------------------------------------------------------------------

export const CategoryMetricsSchema = z.object({
  precision: z.number().min(0).max(1).nullable(),
  recall: z.number().min(0).max(1).nullable(),
});
export type CategoryMetrics = z.infer<typeof CategoryMetricsSchema>;

export const CategoryThresholdSchema = z.object({
  precision_drop_max: z.number().min(0).max(1),
  recall_drop_max: z.number().min(0).max(1),
});
export type CategoryThreshold = z.infer<typeof CategoryThresholdSchema>;

export const BaselineCurrentSchema = z.object({
  pending_measurement: z.boolean().optional(),
  per_category: z.record(ReviewCategorySchema, CategoryMetricsSchema),
});

export const BaselineThresholdsSchema = z.object({
  default_precision_drop_max: z.number().min(0).max(1),
  default_recall_drop_max: z.number().min(0).max(1),
  per_category: z.record(ReviewCategorySchema, CategoryThresholdSchema),
});

export const CategoryBaselineSchema = z
  .object({
    version: z.number().int().positive(),
    thresholds: BaselineThresholdsSchema,
    current: BaselineCurrentSchema,
    history: z.array(z.unknown()),
  })
  .passthrough();
export type CategoryBaseline = z.infer<typeof CategoryBaselineSchema>;

// ---------------------------------------------------------------------------
// Matching: does a candidate finding satisfy an expected finding?
// ---------------------------------------------------------------------------

/**
 * Returns true when `candidateBody` matches at least one pattern from
 * `expectedFinding.must_contain_any`. Patterns are treated as case-insensitive
 * JavaScript RegExp fragments, consistent with the promptfoo assertion style
 * used across the existing golden fixtures.
 */
export function findingMatches(expectedFinding: ExpectedFinding, candidateBody: string): boolean {
  for (const pattern of expectedFinding.must_contain_any) {
    try {
      if (new RegExp(pattern, 'i').test(candidateBody)) return true;
    } catch {
      // Fall back to literal substring match when the pattern is not valid regex.
      if (candidateBody.toLowerCase().includes(pattern.toLowerCase())) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Per-fixture scoring
// ---------------------------------------------------------------------------

export type FixtureScore = {
  readonly fixtureId: string;
  readonly review_category: ReviewCategory;
  /** Number of expected findings covered by at least one actual finding. */
  readonly truePositives: number;
  /** Total expected findings. */
  readonly expectedCount: number;
  /** Total actual findings (for precision denominator). */
  readonly actualCount: number;
  /** Which expected finding IDs were matched. */
  readonly matched: ReadonlyArray<string>;
  /** Which expected finding IDs were not matched (recall misses). */
  readonly missed: ReadonlyArray<string>;
};

/**
 * Score a single fixture against the actual findings the model emitted.
 *
 * Precision is computed from the fixture perspective: a finding is a "true
 * positive" iff at least one expected finding's `must_contain_any` pattern
 * matches its body. Actual findings that match no expected finding are false
 * positives. This is a conservative fixture-level precision proxy; full
 * corpus precision/recall are aggregated by `aggregateCategoryScores`.
 */
export function scoreFixture(
  expected: CategoryExpected,
  actual: ReadonlyArray<ActualFinding>,
  fixtureId: string,
): FixtureScore {
  const matched: string[] = [];
  const missed: string[] = [];

  for (const ef of expected.expected_findings) {
    const hit = actual.some((af) => findingMatches(ef, af.body));
    if (hit) {
      matched.push(ef.id);
    } else {
      missed.push(ef.id);
    }
  }

  return {
    fixtureId,
    review_category: expected.review_category,
    truePositives: matched.length,
    expectedCount: expected.expected_findings.length,
    actualCount: actual.length,
    matched,
    missed,
  };
}

// ---------------------------------------------------------------------------
// Category-level aggregation
// ---------------------------------------------------------------------------

export type CategoryScore = {
  readonly category: ReviewCategory;
  readonly precision: number;
  readonly recall: number;
  readonly fixtureCount: number;
  readonly totalExpected: number;
  readonly totalActual: number;
  readonly totalTruePositives: number;
};

export type AggregateResult = {
  readonly perCategory: ReadonlyMap<ReviewCategory, CategoryScore>;
  readonly perFixture: ReadonlyArray<FixtureScore>;
};

/**
 * Aggregate per-fixture scores into per-category precision and recall.
 *
 * Precision = TP / actual (fraction of actual findings that are correct).
 * Recall    = TP / expected (fraction of expected findings found).
 *
 * When a category has no fixtures, or all fixtures have zero expected
 * findings, precision and recall are both 0 (conservative default).
 */
export function aggregateCategoryScores(perFixture: ReadonlyArray<FixtureScore>): AggregateResult {
  const byCategory = new Map<
    ReviewCategory,
    { tp: number; expected: number; actual: number; fixtureCount: number }
  >();
  for (const cat of REVIEW_CATEGORIES) {
    byCategory.set(cat, { tp: 0, expected: 0, actual: 0, fixtureCount: 0 });
  }
  for (const fx of perFixture) {
    const acc = byCategory.get(fx.review_category);
    if (!acc) continue;
    acc.tp += fx.truePositives;
    acc.expected += fx.expectedCount;
    acc.actual += fx.actualCount;
    acc.fixtureCount += 1;
  }
  const perCategory = new Map<ReviewCategory, CategoryScore>();
  for (const cat of REVIEW_CATEGORIES) {
    const acc = byCategory.get(cat) ?? { tp: 0, expected: 0, actual: 0, fixtureCount: 0 };
    const precision = acc.actual === 0 ? 0 : acc.tp / acc.actual;
    const recall = acc.expected === 0 ? 0 : acc.tp / acc.expected;
    perCategory.set(cat, {
      category: cat,
      precision: Number(precision.toFixed(4)),
      recall: Number(recall.toFixed(4)),
      fixtureCount: acc.fixtureCount,
      totalExpected: acc.expected,
      totalActual: acc.actual,
      totalTruePositives: acc.tp,
    });
  }
  return { perCategory, perFixture };
}

// ---------------------------------------------------------------------------
// Regression gate
// ---------------------------------------------------------------------------

export type GateFinding = {
  readonly category: ReviewCategory;
  readonly metric: 'precision' | 'recall';
  readonly current: number;
  readonly baseline: number;
  readonly dropPp: number;
  readonly maxDropPp: number;
};

export type GateResult = {
  readonly ok: boolean;
  /** Regressions that caused ok=false. */
  readonly regressions: ReadonlyArray<GateFinding>;
  /** Categories where baseline is null (informational, not blocking). */
  readonly unmeasured: ReadonlyArray<ReviewCategory>;
};

/**
 * Compare current category scores against the baseline.
 *
 * A category's metric regresses when:
 *   baseline - current > threshold (in [0, 1])
 *
 * When the baseline metric for a category is null the check is
 * informational — the gate does not block.
 */
export function checkCategoryGate(
  current: ReadonlyMap<ReviewCategory, CategoryScore>,
  baseline: CategoryBaseline,
): GateResult {
  const regressions: GateFinding[] = [];
  const unmeasured: ReviewCategory[] = [];

  for (const cat of REVIEW_CATEGORIES) {
    const currentScore = current.get(cat);
    if (!currentScore) continue;

    const baselineCat = baseline.current.per_category[cat];
    const thresholdCat = baseline.thresholds.per_category[cat];

    const precisionDropMax =
      thresholdCat?.precision_drop_max ?? baseline.thresholds.default_precision_drop_max;
    const recallDropMax =
      thresholdCat?.recall_drop_max ?? baseline.thresholds.default_recall_drop_max;

    if (!baselineCat || baselineCat.precision === null || baselineCat.recall === null) {
      unmeasured.push(cat);
      continue;
    }

    // Round to 6dp before comparison to eliminate floating-point arithmetic noise
    // (e.g. 0.9 - 0.85 = 0.050000000000000044 in IEEE-754).
    const precisionDrop = Number((baselineCat.precision - currentScore.precision).toFixed(6));
    if (precisionDrop > precisionDropMax) {
      regressions.push({
        category: cat,
        metric: 'precision',
        current: currentScore.precision,
        baseline: baselineCat.precision,
        dropPp: Number((precisionDrop * 100).toFixed(2)),
        maxDropPp: Number((precisionDropMax * 100).toFixed(2)),
      });
    }

    const recallDrop = Number((baselineCat.recall - currentScore.recall).toFixed(6));
    if (recallDrop > recallDropMax) {
      regressions.push({
        category: cat,
        metric: 'recall',
        current: currentScore.recall,
        baseline: baselineCat.recall,
        dropPp: Number((recallDrop * 100).toFixed(2)),
        maxDropPp: Number((recallDropMax * 100).toFixed(2)),
      });
    }
  }

  return {
    ok: regressions.length === 0,
    regressions,
    unmeasured,
  };
}

// ---------------------------------------------------------------------------
// Human-readable report
// ---------------------------------------------------------------------------

/**
 * Format a gate run into a human-readable report suitable for CI stdout.
 * Lines are newline-joined; no trailing newline — callers add one.
 */
export function renderGateReport(result: AggregateResult, gate: GateResult): string {
  const lines: string[] = [];
  lines.push('=== review-category precision/recall gate ===');
  lines.push('');
  lines.push('Per-category scores:');
  for (const cat of REVIEW_CATEGORIES) {
    const cs = result.perCategory.get(cat);
    if (!cs) continue;
    const prec = `precision=${(cs.precision * 100).toFixed(1)}%`;
    const rec = `recall=${(cs.recall * 100).toFixed(1)}%`;
    const counts = `fixtures=${cs.fixtureCount}  tp=${cs.totalTruePositives}/${cs.totalExpected}`;
    lines.push(`  [${cat}]  ${prec}  ${rec}  ${counts}`);
  }
  lines.push('');
  if (gate.unmeasured.length > 0) {
    lines.push(`Unmeasured categories (informational): ${gate.unmeasured.join(', ')}`);
    lines.push('  Run `pnpm eval:baseline --apply` to record the initial baseline.');
    lines.push('');
  }
  if (gate.regressions.length > 0) {
    lines.push('GATE: REGRESSED');
    for (const r of gate.regressions) {
      lines.push(
        `  [${r.category}] ${r.metric}: ${(r.current * 100).toFixed(1)}% (was ${(r.baseline * 100).toFixed(1)}%) — drop ${r.dropPp}pp exceeds max ${r.maxDropPp}pp`,
      );
    }
  } else {
    lines.push('GATE: ok');
  }
  return lines.join('\n');
}
