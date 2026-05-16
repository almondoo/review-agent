// Pure logic for the severity-consistency eval (#68). Isolated from
// I/O so the scoring math is unit-testable without an LLM / disk.

import { z } from 'zod';

// Canonical SEVERITIES from @review-agent/core/src/review.ts. Duplicated
// here as a literal tuple so this script stays free of cross-package
// runtime deps — @review-agent/eval is the only OSS package that
// historically depends only on zod + tsx.
export const SEVERITY_ORDER = ['info', 'minor', 'major', 'critical'] as const;
export type Severity = (typeof SEVERITY_ORDER)[number];

export const SeveritySchema = z.enum(SEVERITY_ORDER);

export const FixtureExpectedSchema = z
  .object({
    category: z.literal('severity-calibration'),
    bug_class: z.string().min(1),
    language: z.string().min(1),
    severity_min: SeveritySchema,
    severity_max: SeveritySchema,
    severity_modal: SeveritySchema,
    rationale: z.string().min(1),
    must_contain_any: z.array(z.string()).optional(),
  })
  .refine((v) => severityRank(v.severity_min) <= severityRank(v.severity_max), {
    message: 'severity_min must be <= severity_max',
  })
  .refine(
    (v) =>
      severityRank(v.severity_min) <= severityRank(v.severity_modal) &&
      severityRank(v.severity_modal) <= severityRank(v.severity_max),
    { message: 'severity_modal must lie within [severity_min, severity_max]' },
  );

export type FixtureExpected = z.infer<typeof FixtureExpectedSchema>;

export const ManifestEntrySchema = z.object({
  id: z.string().regex(/^\d{2}-[a-z0-9-]+$/),
  category: z.string(),
  expected_severity_modal: SeveritySchema,
});

export const ManifestSchema = z.object({
  version: z.number().int().positive(),
  description: z.string(),
  n_runs_per_fixture: z.number().int().min(2).max(10),
  stability_threshold: z.number().min(0).max(1),
  fixtures: z.array(ManifestEntrySchema).min(5).max(10),
});

export type Manifest = z.infer<typeof ManifestSchema>;

export function severityRank(s: Severity): number {
  return SEVERITY_ORDER.indexOf(s);
}

// The "primary" finding for severity calibration is the highest-severity
// finding the model produced. Ties broken by first-occurrence in the
// model's output. Returns null when the model produced zero findings.
export function primarySeverity(comments: ReadonlyArray<{ severity: Severity }>): Severity | null {
  const first = comments[0];
  if (!first) return null;
  let best: Severity = first.severity;
  for (const c of comments) {
    if (severityRank(c.severity) > severityRank(best)) best = c.severity;
  }
  return best;
}

// Modal severity = the most-frequent severity across runs. Ties broken
// by SEVERITY_ORDER index (lower index wins). A modal-null result means
// every run produced zero comments; we treat that as a separate failure
// kind so the CI surface can distinguish "model emits wrong severity"
// from "model emits nothing at all".
export function modalSeverity(runs: ReadonlyArray<Severity | null>): Severity | null {
  const counts = new Map<Severity, number>();
  for (const r of runs) {
    if (r !== null) counts.set(r, (counts.get(r) ?? 0) + 1);
  }
  if (counts.size === 0) return null;
  let best: Severity = SEVERITY_ORDER[0];
  let bestCount = -1;
  for (const sev of SEVERITY_ORDER) {
    const c = counts.get(sev) ?? 0;
    if (c > bestCount) {
      best = sev;
      bestCount = c;
    }
  }
  return best;
}

export type FixtureRunResult = {
  readonly fixtureId: string;
  readonly runs: ReadonlyArray<Severity | null>;
};

export type FixtureScore = {
  readonly fixtureId: string;
  readonly modal: Severity | null;
  readonly modalCount: number;
  readonly totalRuns: number;
  readonly stable: boolean;
  readonly withinRange: boolean;
  readonly passed: boolean;
  readonly reason?: string;
};

// Score a single fixture. A fixture passes iff:
//   - every run produced a non-null severity (model didn't go silent),
//   - the modal severity is reached in ≥ stabilityThreshold of runs,
//   - every individual run's severity is within [severity_min, severity_max].
export function scoreFixture(
  expected: FixtureExpected,
  result: FixtureRunResult,
  stabilityThreshold: number,
): FixtureScore {
  if (result.runs.length === 0) {
    return {
      fixtureId: result.fixtureId,
      modal: null,
      modalCount: 0,
      totalRuns: 0,
      stable: false,
      withinRange: false,
      passed: false,
      reason: 'no runs',
    };
  }
  if (result.runs.some((r) => r === null)) {
    return {
      fixtureId: result.fixtureId,
      modal: modalSeverity(result.runs),
      modalCount: 0,
      totalRuns: result.runs.length,
      stable: false,
      withinRange: false,
      passed: false,
      reason: 'one or more runs produced zero comments',
    };
  }
  const runs = result.runs as ReadonlyArray<Severity>;
  // Safe: every entry is non-null (checked above) and length > 0 (checked above),
  // so modalSeverity is guaranteed to return a Severity.
  const modal = modalSeverity(runs) as Severity;
  const modalCount = runs.filter((r) => r === modal).length;
  const stable = modalCount / runs.length >= stabilityThreshold;
  const min = severityRank(expected.severity_min);
  const max = severityRank(expected.severity_max);
  const withinRange = runs.every((r) => {
    const rk = severityRank(r);
    return rk >= min && rk <= max;
  });
  const passed = stable && withinRange;
  const reasons: string[] = [];
  if (!stable) {
    reasons.push(
      `modal '${modal}' produced in ${modalCount}/${runs.length} runs (below ${stabilityThreshold} threshold)`,
    );
  }
  if (!withinRange) {
    const offending = runs.filter((r) => {
      const rk = severityRank(r);
      return rk < min || rk > max;
    });
    reasons.push(
      `runs outside [${expected.severity_min}, ${expected.severity_max}]: ${offending.join(', ')}`,
    );
  }
  return {
    fixtureId: result.fixtureId,
    modal,
    modalCount,
    totalRuns: runs.length,
    stable,
    withinRange,
    passed,
    ...(reasons.length > 0 ? { reason: reasons.join('; ') } : {}),
  };
}

export type AggregateScore = {
  readonly fixturesEvaluated: number;
  readonly fixturesPassed: number;
  readonly score: number;
  readonly perFixture: ReadonlyArray<FixtureScore>;
};

export function aggregateScore(perFixture: ReadonlyArray<FixtureScore>): AggregateScore {
  const passed = perFixture.filter((f) => f.passed).length;
  const total = perFixture.length;
  const score = total === 0 ? 0 : passed / total;
  return {
    fixturesEvaluated: total,
    fixturesPassed: passed,
    score: Number(score.toFixed(4)),
    perFixture,
  };
}

// Baseline gate: fail when the current score drops > maxDropPp percentage
// points below the baseline. `baselineScore` is in [0, 1]; `maxDropPp` is
// expressed in percentage points (5 means 0.05 of a normalized score).
export function checkGate(
  currentScore: number,
  baselineScore: number | null,
  maxDropPp: number,
): { readonly ok: boolean; readonly reason?: string } {
  if (baselineScore === null) {
    return { ok: true };
  }
  const dropPp = (baselineScore - currentScore) * 100;
  if (dropPp > maxDropPp) {
    return {
      ok: false,
      reason: `severity_consistency_score dropped ${dropPp.toFixed(2)}pp (baseline ${(baselineScore * 100).toFixed(2)}%, current ${(currentScore * 100).toFixed(2)}%) — exceeds ${maxDropPp}pp ceiling`,
    };
  }
  return { ok: true };
}
