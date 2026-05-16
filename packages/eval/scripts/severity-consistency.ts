#!/usr/bin/env node
// Severity-consistency scoring CLI (#68).
//
// Reads:
//   1. The severity-calibration manifest + per-fixture expected.json.
//   2. A results JSON describing N runs per fixture. Shape:
//        {
//          "results": [
//            { "fixtureId": "01-sql-injection-critical",
//              "runs": [
//                { "comments": [{ "severity": "critical" }, ...] },
//                ...
//              ]
//            }, ...
//          ]
//        }
//      One results object can be hand-written for testing, or generated
//      by a future shim around `promptfoo eval --output ...`. The
//      decoupling lets the CI gate work even when the LLM driver
//      changes shape.
//   3. The baseline severity_consistency_score from baseline.json.
//
// Writes (always to stdout):
//   - The per-fixture pass/fail breakdown.
//   - The aggregate severity_consistency_score (0-1, 4dp).
//   - A gate verdict: ok | regressed.
//
// Exit code 0 on ok, 1 on regression.

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  aggregateScore,
  checkGate,
  FixtureExpectedSchema,
  type FixtureRunResult,
  ManifestSchema,
  SeveritySchema,
  scoreFixture,
} from './severity-consistency-core.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(HERE, '..', 'fixtures', 'severity-calibration');
const BASELINE_PATH = join(HERE, '..', 'baseline.json');

const ResultsSchema = z.object({
  results: z.array(
    z.object({
      fixtureId: z.string(),
      runs: z.array(
        z.object({
          comments: z.array(z.object({ severity: SeveritySchema }).passthrough()),
        }),
      ),
    }),
  ),
});

export type ResultsFile = z.infer<typeof ResultsSchema>;

const BaselineCurrentPassRatesSchema = z
  .object({
    severity_consistency_score: z.number().nullable().optional(),
  })
  .passthrough();
const BaselineSchema = z
  .object({
    current_pass_rates: BaselineCurrentPassRatesSchema,
  })
  .passthrough();

export type RunResults = ResultsFile['results'][number];

function parseArgs(argv: ReadonlyArray<string>): {
  resultsPath: string;
  fixturesDir: string;
  baselinePath: string;
  maxDropPp: number;
} {
  let resultsPath = '';
  let fixturesDir = FIXTURES_DIR;
  let baselinePath = BASELINE_PATH;
  let maxDropPp = 5;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--results') {
      resultsPath = argv[i + 1] ?? '';
      i += 1;
    } else if (a === '--fixtures-dir') {
      fixturesDir = argv[i + 1] ?? FIXTURES_DIR;
      i += 1;
    } else if (a === '--baseline') {
      baselinePath = argv[i + 1] ?? BASELINE_PATH;
      i += 1;
    } else if (a === '--max-drop-pp') {
      maxDropPp = Number.parseFloat(argv[i + 1] ?? '5');
      i += 1;
    }
  }
  if (!resultsPath) {
    throw new Error(
      'Usage: severity-consistency --results <results.json> [--fixtures-dir <dir>] [--baseline <path>] [--max-drop-pp <n>]',
    );
  }
  return { resultsPath, fixturesDir, baselinePath, maxDropPp };
}

async function readJson<T>(path: string, parser: (raw: unknown) => T): Promise<T> {
  const raw = await readFile(path, 'utf8');
  return parser(JSON.parse(raw));
}

export async function runScoring(opts: {
  readonly resultsPath: string;
  readonly fixturesDir: string;
  readonly baselinePath: string;
  readonly maxDropPp: number;
}): Promise<{
  readonly ok: boolean;
  readonly score: number;
  readonly baseline: number | null;
  readonly report: string;
}> {
  const manifest = await readJson(join(opts.fixturesDir, 'manifest.json'), (v) =>
    ManifestSchema.parse(v),
  );
  const results = await readJson(opts.resultsPath, (v) => ResultsSchema.parse(v));
  const baseline = await readJson(opts.baselinePath, (v) => BaselineSchema.parse(v));

  const expectedById = new Map<string, Awaited<ReturnType<typeof loadExpected>>>();
  for (const entry of manifest.fixtures) {
    expectedById.set(entry.id, await loadExpected(opts.fixturesDir, entry.id));
  }

  const perFixture = manifest.fixtures.map((entry) => {
    const expected = expectedById.get(entry.id);
    if (!expected) {
      return {
        fixtureId: entry.id,
        modal: null,
        modalCount: 0,
        totalRuns: 0,
        stable: false,
        withinRange: false,
        passed: false,
        reason: 'expected.json missing',
      };
    }
    const result = results.results.find((r) => r.fixtureId === entry.id);
    if (!result) {
      return {
        fixtureId: entry.id,
        modal: null,
        modalCount: 0,
        totalRuns: 0,
        stable: false,
        withinRange: false,
        passed: false,
        reason: 'no runs in results file',
      };
    }
    const runs: FixtureRunResult = {
      fixtureId: entry.id,
      runs: result.runs.map((r) => {
        const first = r.comments[0];
        if (!first) return null;
        let max = first.severity;
        for (const c of r.comments) {
          if (SeveritySchema.options.indexOf(c.severity) > SeveritySchema.options.indexOf(max)) {
            max = c.severity;
          }
        }
        return max;
      }),
    };
    return scoreFixture(expected, runs, manifest.stability_threshold);
  });

  const agg = aggregateScore(perFixture);
  const baselineScore = baseline.current_pass_rates.severity_consistency_score ?? null;
  const gate = checkGate(agg.score, baselineScore, opts.maxDropPp);

  const lines: string[] = [];
  lines.push(
    `severity_consistency_score: ${(agg.score * 100).toFixed(2)}%  (${agg.fixturesPassed}/${agg.fixturesEvaluated})`,
  );
  lines.push(
    `baseline: ${baselineScore === null ? '<unmeasured>' : `${(baselineScore * 100).toFixed(2)}%`}  gate: max drop ${opts.maxDropPp}pp`,
  );
  lines.push('');
  for (const f of agg.perFixture) {
    const status = f.passed ? 'PASS' : 'FAIL';
    const reason = f.reason ? ` — ${f.reason}` : '';
    lines.push(
      `  [${status}] ${f.fixtureId} (modal=${f.modal ?? 'null'}, ${f.modalCount}/${f.totalRuns})${reason}`,
    );
  }
  lines.push('');
  if (gate.ok) {
    lines.push('GATE: ok');
  } else {
    lines.push(`GATE: REGRESSED — ${gate.reason ?? ''}`);
  }
  return {
    ok: gate.ok,
    score: agg.score,
    baseline: baselineScore,
    report: lines.join('\n'),
  };
}

async function loadExpected(fixturesDir: string, id: string) {
  return readJson(join(fixturesDir, id, 'expected.json'), (v) => FixtureExpectedSchema.parse(v));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const result = await runScoring(args);
  process.stdout.write(`${result.report}\n`);
  process.exit(result.ok ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
