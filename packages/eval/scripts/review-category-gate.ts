#!/usr/bin/env node
// Per-category review-quality regression gate CLI (#143).
//
// Reads:
//   1. fixtures/golden/category/manifest.json — the versioned category fixture set.
//   2. Per-fixture expected.json files (fixtures/golden/category/<id>/expected.json).
//   3. A candidate-results JSON (produced by the live-LLM runner or a test harness):
//        {
//          "results": [
//            { "fixtureId": "security/hardcoded-secret",
//              "findings": [{ "body": "Hardcoded credential..." }]
//            }, ...
//          ]
//        }
//   4. category-baseline.json — per-category precision/recall baseline + thresholds.
//
// Writes to stdout:
//   - Per-category precision / recall.
//   - Gate verdict: ok | REGRESSED.
//
// Exit code 0 on ok, 1 on regression. When all baseline values are null
// (first run, pending_measurement) the gate reports scores but exits 0.
//
// CLI:
//   pnpm --filter @review-agent/eval eval:gate -- \
//     --results <path/to/candidate-results.json> \
//     [--fixtures-dir <path>] [--baseline <path>]
//
// Temperature requirement: the candidate-results file MUST have been produced
// with temperature=0 (or a fixed seed). See docs/eval/category-gate.md.

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { z } from 'zod';
import {
  aggregateCategoryScores,
  CandidateRunsSchema,
  CategoryBaselineSchema,
  CategoryExpectedSchema,
  CategoryManifestSchema,
  checkCategoryGate,
  renderGateReport,
  scoreFixture,
} from './review-category-gate-core.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_FIXTURES_DIR = join(HERE, '..', 'fixtures', 'golden', 'category');
const DEFAULT_BASELINE_PATH = join(HERE, '..', 'category-baseline.json');

function parseArgs(argv: ReadonlyArray<string>): {
  resultsPath: string;
  fixturesDir: string;
  baselinePath: string;
} {
  let resultsPath = '';
  let fixturesDir = DEFAULT_FIXTURES_DIR;
  let baselinePath = DEFAULT_BASELINE_PATH;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--results') {
      resultsPath = argv[i + 1] ?? '';
      i += 1;
    } else if (a === '--fixtures-dir') {
      fixturesDir = argv[i + 1] ?? DEFAULT_FIXTURES_DIR;
      i += 1;
    } else if (a === '--baseline') {
      baselinePath = argv[i + 1] ?? DEFAULT_BASELINE_PATH;
      i += 1;
    }
  }
  if (!resultsPath) {
    throw new Error(
      'Usage: eval:gate -- --results <candidate-results.json> [--fixtures-dir <dir>] [--baseline <path>]',
    );
  }
  return { resultsPath, fixturesDir, baselinePath };
}

async function readJson<T>(path: string, schema: z.ZodType<T>): Promise<T> {
  const raw = await readFile(path, 'utf8');
  return schema.parse(JSON.parse(raw));
}

export async function runGate(opts: {
  readonly resultsPath: string;
  readonly fixturesDir: string;
  readonly baselinePath: string;
}): Promise<{
  readonly ok: boolean;
  readonly report: string;
}> {
  const manifest = await readJson(join(opts.fixturesDir, 'manifest.json'), CategoryManifestSchema);
  const candidateRuns = await readJson(opts.resultsPath, CandidateRunsSchema);
  const baseline = await readJson(opts.baselinePath, CategoryBaselineSchema);

  const runsByFixture = new Map(candidateRuns.results.map((r) => [r.fixtureId, r.findings]));

  const perFixture = await Promise.all(
    manifest.fixtures.map(async (entry) => {
      const expected = await readJson(
        join(opts.fixturesDir, entry.id, 'expected.json'),
        CategoryExpectedSchema,
      );
      const actual = runsByFixture.get(entry.id) ?? [];
      return scoreFixture(expected, actual, entry.id);
    }),
  );

  const aggregate = aggregateCategoryScores(perFixture);
  const gate = checkCategoryGate(aggregate.perCategory, baseline);
  const report = renderGateReport(aggregate, gate);

  return { ok: gate.ok, report };
}

/* v8 ignore start */
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const result = await runGate(args);
  process.stdout.write(`${result.report}\n`);
  process.exit(result.ok ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
/* v8 ignore stop */
