import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildScoringInput } from '../promptfoo-to-severity-input.js';
import { runScoring } from '../severity-consistency.js';

// Pipeline regression test for v1.2 epic #83 Phase 1 (#90). Composes:
//
//   promptfoo output -> buildScoringInput -> runScoring -> gate verdict
//
// without touching the network. Covers the exact path
// `.github/workflows/eval.yml` runs each PR. Pins:
//
//   - Happy path: all six fixtures emit critical/major → score 1.0 →
//     ok against a null baseline AND against a measured baseline of
//     1.0.
//   - Regression: half the fixtures emit `info` so the modal
//     severity falls outside [severity_min, severity_max] → gate
//     fails when the baseline is high.
//   - Recovery: a measured baseline of 0.0 + current score 1.0 →
//     ok (improvement, no false failure).
//
// All three are short-circuits of the CI gate; together they prove
// the unconditional gate path that #90 wired up works as designed
// without burning the Anthropic budget.

const FIXTURES_DIR = join(__dirname, '..', '..', 'fixtures', 'severity-calibration');

type Severity = 'info' | 'minor' | 'major' | 'critical';

function promptfooRow(fixtureId: string, severity: Severity) {
  return {
    vars: { diff: `file://fixtures/severity-calibration/${fixtureId}/diff.txt` },
    response: { output: { comments: [{ severity }] } },
  };
}

function promptfooOutput(rows: Array<{ id: string; severities: Severity[] }>) {
  // Three runs per fixture per severity-consistency.promptfooconfig.yaml.
  const flat = rows.flatMap((r) => r.severities.map((s) => promptfooRow(r.id, s)));
  return { results: { results: flat } };
}

async function withTempFile(contents: object, fn: (path: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'eval-gate-test-'));
  const path = join(dir, 'input.json');
  await writeFile(path, JSON.stringify(contents));
  try {
    await fn(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function writeBaseline(score: number | null): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'eval-baseline-'));
  const path = join(dir, 'baseline.json');
  // Mirror the production baseline.json shape; only the score
  // and the schema-required wrapper matter for `checkGate`.
  await writeFile(
    path,
    JSON.stringify({
      version: 1,
      current_pass_rates: { severity_consistency_score: score },
    }),
  );
  return path;
}

const ALL_FIXTURES: Array<{ id: string; severities: Severity[] }> = [
  // Modal severity = expected_severity_modal in manifest.json.
  { id: '01-sql-injection-critical', severities: ['critical', 'critical', 'critical'] },
  { id: '02-path-traversal-critical', severities: ['critical', 'critical', 'critical'] },
  { id: '03-missing-await-major', severities: ['major', 'major', 'major'] },
  { id: '04-off-by-one-major', severities: ['major', 'major', 'major'] },
  { id: '05-magic-number-minor', severities: ['minor', 'minor', 'minor'] },
  { id: '06-debug-log-info', severities: ['info', 'info', 'info'] },
];

describe('end-to-end severity-consistency gate (#90 / Phase 1)', () => {
  it('happy path: every fixture emits its modal severity -> score 1.0 -> gate ok', async () => {
    const scoringInput = buildScoringInput(promptfooOutput(ALL_FIXTURES));
    await withTempFile(scoringInput, async (resultsPath) => {
      const baselinePath = await writeBaseline(1.0);
      try {
        const r = await runScoring({
          resultsPath,
          fixturesDir: FIXTURES_DIR,
          baselinePath,
          maxDropPp: 5,
        });
        expect(r.score).toBe(1);
        expect(r.ok).toBe(true);
        expect(r.report).toContain('GATE: ok');
      } finally {
        await rm(baselinePath, { recursive: true, force: true });
      }
    });
  });

  it('regression: half the fixtures emit info instead of their modal -> gate fails against a high baseline', async () => {
    // Three fixtures land outside [severity_min, severity_max] → fail
    // their per-fixture score → aggregate drops below 1.0 → drop >
    // 5pp against a baseline of 1.0 → CI gate reports REGRESSED.
    const broken: Array<{ id: string; severities: Severity[] }> = [
      { id: '01-sql-injection-critical', severities: ['info', 'info', 'info'] },
      { id: '02-path-traversal-critical', severities: ['info', 'info', 'info'] },
      { id: '03-missing-await-major', severities: ['info', 'info', 'info'] },
      { id: '04-off-by-one-major', severities: ['major', 'major', 'major'] },
      { id: '05-magic-number-minor', severities: ['minor', 'minor', 'minor'] },
      { id: '06-debug-log-info', severities: ['info', 'info', 'info'] },
    ];
    const scoringInput = buildScoringInput(promptfooOutput(broken));
    await withTempFile(scoringInput, async (resultsPath) => {
      const baselinePath = await writeBaseline(1.0);
      try {
        const r = await runScoring({
          resultsPath,
          fixturesDir: FIXTURES_DIR,
          baselinePath,
          maxDropPp: 5,
        });
        expect(r.score).toBeLessThan(1);
        expect(r.ok).toBe(false);
        expect(r.report).toContain('REGRESSED');
      } finally {
        await rm(baselinePath, { recursive: true, force: true });
      }
    });
  });

  it('null baseline is informational - gate stays ok even when half the fixtures fail', async () => {
    // Mirrors the post-merge state before the operator runs
    // `baseline:measure --apply` for the first time. The score
    // is reported in stdout but the gate does not block the build.
    const broken: Array<{ id: string; severities: Severity[] }> = [
      { id: '01-sql-injection-critical', severities: ['info', 'info', 'info'] },
      { id: '02-path-traversal-critical', severities: ['info', 'info', 'info'] },
      { id: '03-missing-await-major', severities: ['info', 'info', 'info'] },
      ...ALL_FIXTURES.slice(3),
    ];
    const scoringInput = buildScoringInput(promptfooOutput(broken));
    await withTempFile(scoringInput, async (resultsPath) => {
      const baselinePath = await writeBaseline(null);
      try {
        const r = await runScoring({
          resultsPath,
          fixturesDir: FIXTURES_DIR,
          baselinePath,
          maxDropPp: 5,
        });
        expect(r.ok).toBe(true);
        expect(r.report).toContain('baseline: <unmeasured>');
      } finally {
        await rm(baselinePath, { recursive: true, force: true });
      }
    });
  });

  it('improvement is never flagged as regression (current > baseline)', async () => {
    const scoringInput = buildScoringInput(promptfooOutput(ALL_FIXTURES));
    await withTempFile(scoringInput, async (resultsPath) => {
      const baselinePath = await writeBaseline(0.5);
      try {
        const r = await runScoring({
          resultsPath,
          fixturesDir: FIXTURES_DIR,
          baselinePath,
          maxDropPp: 5,
        });
        expect(r.score).toBe(1);
        expect(r.ok).toBe(true);
      } finally {
        await rm(baselinePath, { recursive: true, force: true });
      }
    });
  });

  // Smoke: the test fixtures on disk haven't drifted from the manifest.
  it('FIXTURES_DIR resolves to a directory the suite can read manifest.json from', async () => {
    const manifest = await readFile(join(FIXTURES_DIR, 'manifest.json'), 'utf8');
    expect(manifest).toContain('"fixtures"');
  });
});
