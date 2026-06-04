#!/usr/bin/env node
// Baseline capture / promotion CLI for the per-category regression gate (#143).
//
// Operator workflow (deliberate opt-in — never runs automatically):
//   1. Run the category gate to produce candidate-results.json (with temperature=0).
//   2. Inspect the printed precision/recall scores.
//   3. If the scores look correct, promote them as the new baseline:
//
//        pnpm --filter @review-agent/eval eval:baseline -- \
//          --results <candidate-results.json> \
//          --git-sha $(git rev-parse HEAD) \
//          --model-id claude-sonnet-4-6 \
//          --apply
//
// Without `--apply` this script prints what it would write and exits 0
// (dry-run mode). The `--apply` flag is the deliberate gating mechanism
// described in AC #6: a human must explicitly pass it to promote a baseline.
//
// `category-baseline.json` changes are a PR-reviewable artefact — the
// history array accumulates every measurement for traceability.

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { z } from 'zod';
import {
  aggregateCategoryScores,
  CandidateRunsSchema,
  CategoryBaselineSchema,
  CategoryExpectedSchema,
  CategoryManifestSchema,
  REVIEW_CATEGORIES,
  type ReviewCategory,
  scoreFixture,
} from './review-category-gate-core.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_FIXTURES_DIR = join(HERE, '..', 'fixtures', 'golden', 'category');
const DEFAULT_BASELINE_PATH = join(HERE, '..', 'category-baseline.json');

type Args = {
  resultsPath: string;
  fixturesDir: string;
  baselinePath: string;
  modelId: string;
  gitSha: string;
  notes: string;
  apply: boolean;
};

function parseArgs(argv: ReadonlyArray<string>): Args {
  let resultsPath = '';
  let fixturesDir = DEFAULT_FIXTURES_DIR;
  let baselinePath = DEFAULT_BASELINE_PATH;
  let modelId = 'claude-sonnet-4-6';
  let gitSha = '';
  let notes = '';
  let apply = false;
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
      'Usage: eval:baseline -- --results <candidate-results.json> [--model-id <id>] [--git-sha <sha>] [--notes <text>] [--apply]',
    );
  }
  return { resultsPath, fixturesDir, baselinePath, modelId, gitSha, notes, apply };
}

async function readJson<T>(path: string, schema: z.ZodType<T>): Promise<T> {
  const raw = await readFile(path, 'utf8');
  return schema.parse(JSON.parse(raw));
}

export async function measureCategoryBaseline(opts: {
  readonly resultsPath: string;
  readonly fixturesDir: string;
  readonly baselinePath: string;
  readonly modelId: string;
  readonly gitSha: string;
  readonly notes: string;
  readonly apply: boolean;
}): Promise<{
  readonly perCategory: ReadonlyMap<
    ReviewCategory,
    { readonly precision: number; readonly recall: number }
  >;
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

  const lines: string[] = ['=== review-category baseline capture ===', ''];
  for (const cat of REVIEW_CATEGORIES) {
    const cs = aggregate.perCategory.get(cat);
    if (!cs) continue;
    lines.push(
      `  [${cat}]  precision=${(cs.precision * 100).toFixed(2)}%  recall=${(cs.recall * 100).toFixed(2)}%`,
    );
  }
  lines.push('');
  lines.push(`model: ${opts.modelId}`);
  lines.push(`git_sha: ${opts.gitSha || '<unspecified>'}`);
  lines.push(
    `apply: ${opts.apply ? 'YES — category-baseline.json will be rewritten' : 'NO (dry-run)'}`,
  );

  if (opts.apply) {
    const recordedAt = new Date().toISOString().slice(0, 10);
    const newPerCategory: Record<string, { precision: number; recall: number }> = {};
    for (const cat of REVIEW_CATEGORIES) {
      const cs = aggregate.perCategory.get(cat);
      newPerCategory[cat] = {
        precision: cs?.precision ?? 0,
        recall: cs?.recall ?? 0,
      };
    }
    const historyEntry: Record<string, unknown> = {
      recorded_at: recordedAt,
      model_id: opts.modelId,
      git_sha: opts.gitSha || null,
      notes: opts.notes || null,
      per_category: newPerCategory,
    };

    // Re-read the raw baseline to patch in-place, preserving unknown fields.
    const rawBaseline = JSON.parse(await readFile(opts.baselinePath, 'utf8')) as Record<
      string,
      unknown
    >;
    rawBaseline.recorded_at = recordedAt;
    rawBaseline.model = opts.modelId;
    rawBaseline.git_sha = opts.gitSha || null;
    const currentBlock = rawBaseline.current as Record<string, unknown>;
    currentBlock.pending_measurement = false;
    currentBlock.per_category = newPerCategory;
    const historyArr = Array.isArray(rawBaseline.history) ? (rawBaseline.history as unknown[]) : [];
    historyArr.push(historyEntry);
    rawBaseline.history = historyArr;

    await writeFile(opts.baselinePath, `${JSON.stringify(rawBaseline, null, 2)}\n`);
    lines.push(`category-baseline.json updated (${recordedAt}).`);
  }

  const perCategory = new Map<ReviewCategory, { precision: number; recall: number }>();
  for (const cat of REVIEW_CATEGORIES) {
    const cs = aggregate.perCategory.get(cat);
    perCategory.set(cat, { precision: cs?.precision ?? 0, recall: cs?.recall ?? 0 });
  }

  // Validate we haven't drifted the baseline schema.
  CategoryBaselineSchema.parse(baseline);

  return { perCategory, report: lines.join('\n') };
}

/* v8 ignore start */
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const result = await measureCategoryBaseline(args);
  process.stdout.write(`${result.report}\n`);
  if (!args.apply) {
    process.stdout.write('\nDry run — re-invoke with --apply to update category-baseline.json.\n');
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
/* v8 ignore stop */
