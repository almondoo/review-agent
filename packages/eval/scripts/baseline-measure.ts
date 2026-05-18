#!/usr/bin/env node
// Baseline measurement CLI for the severity-consistency score (#90).
//
// Operator workflow:
//   1. ANTHROPIC_API_KEY=... pnpm --filter @review-agent/eval eval:severity-consistency
//   2. pnpm --filter @review-agent/eval shim:severity-input -- --in severity-consistency-results.json --out severity-consistency-input.json
//   3. pnpm --filter @review-agent/eval baseline:measure -- \
//        --results severity-consistency-input.json \
//        --git-sha $(git rev-parse HEAD) \
//        --apply
//
// The `--apply` flag merges the measured score into `baseline.json`'s
// `current_pass_rates` and pushes a snapshot into the `history`
// array. Without `--apply` the CLI prints what it would write and
// exits 0 — useful for CI dry-runs and code review.

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  aggregateScore,
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

const BaselineSchema = z
  .object({
    current_pass_rates: z.object({}).passthrough(),
    history: z.array(z.unknown()).default([]),
  })
  .passthrough();

type Args = {
  resultsPath: string;
  modelId: string;
  gitSha: string;
  notes: string;
  apply: boolean;
};

function parseArgs(argv: ReadonlyArray<string>): Args {
  let resultsPath = '';
  let modelId = 'claude-sonnet-4-6';
  let gitSha = '';
  let notes = '';
  let apply = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--results') {
      resultsPath = argv[i + 1] ?? '';
      i += 1;
    } else if (a === '--model-id') {
      modelId = argv[i + 1] ?? modelId;
      i += 1;
    } else if (a === '--git-sha') {
      gitSha = argv[i + 1] ?? '';
      i += 1;
    } else if (a === '--notes') {
      notes = argv[i + 1] ?? '';
      i += 1;
    } else if (a === '--apply') {
      apply = true;
    }
  }
  if (!resultsPath) {
    throw new Error(
      'Usage: baseline-measure --results <input.json> [--model-id <id>] [--git-sha <sha>] [--notes <text>] [--apply]',
    );
  }
  return { resultsPath, modelId, gitSha, notes, apply };
}

async function readJson<T>(path: string, parser: (raw: unknown) => T): Promise<T> {
  const raw = await readFile(path, 'utf8');
  return parser(JSON.parse(raw));
}

async function loadExpected(fixturesDir: string, id: string) {
  return readJson(join(fixturesDir, id, 'expected.json'), (v) => FixtureExpectedSchema.parse(v));
}

export async function measureBaseline(args: Args): Promise<{
  readonly score: number;
  readonly fixturesPassed: number;
  readonly fixturesEvaluated: number;
  readonly report: string;
}> {
  const manifest = await readJson(join(FIXTURES_DIR, 'manifest.json'), (v) =>
    ManifestSchema.parse(v),
  );
  const results = await readJson(args.resultsPath, (v) => ResultsSchema.parse(v));

  const expectedById = new Map<string, Awaited<ReturnType<typeof loadExpected>>>();
  for (const entry of manifest.fixtures) {
    expectedById.set(entry.id, await loadExpected(FIXTURES_DIR, entry.id));
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
  const lines = [
    `severity_consistency_score: ${(agg.score * 100).toFixed(2)}%  (${agg.fixturesPassed}/${agg.fixturesEvaluated})`,
    `model: ${args.modelId}`,
    `git_sha: ${args.gitSha || '<unspecified>'}`,
    `apply: ${args.apply ? 'YES (baseline.json will be rewritten)' : 'no (dry-run)'}`,
  ];
  return {
    score: agg.score,
    fixturesPassed: agg.fixturesPassed,
    fixturesEvaluated: agg.fixturesEvaluated,
    report: lines.join('\n'),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const measurement = await measureBaseline(args);
  process.stdout.write(`${measurement.report}\n`);
  if (!args.apply) {
    process.stdout.write('Dry run — re-invoke with --apply to update baseline.json.\n');
    return;
  }
  const baseline = await readJson(BASELINE_PATH, (v) => BaselineSchema.parse(v));
  const recordedAt = new Date().toISOString().slice(0, 10);
  const current = baseline.current_pass_rates as Record<string, unknown>;
  current.severity_consistency_score = Number(measurement.score.toFixed(4));
  current.pending_measurement = false;
  current.measurement_metadata = {
    recorded_at: recordedAt,
    model_id: args.modelId,
    git_sha: args.gitSha || null,
    notes: args.notes || 'Recorded via baseline-measure --apply',
  };
  baseline.history = [
    ...baseline.history,
    {
      recorded_at: recordedAt,
      model_id: args.modelId,
      git_sha: args.gitSha || null,
      severity_consistency_score: Number(measurement.score.toFixed(4)),
      fixtures_passed: measurement.fixturesPassed,
      fixtures_evaluated: measurement.fixturesEvaluated,
      notes: args.notes || null,
    },
  ];
  await writeFile(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`);
  process.stdout.write(`baseline.json updated (${recordedAt}, ${args.modelId}).\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
