#!/usr/bin/env node
// Shim: promptfoo output -> severity-consistency-input.json (#83 / #90).
//
// The scoring CLI (scripts/severity-consistency.ts) expects a per-fixture
// grouping. promptfoo emits a flat list of test runs. This shim does
// the translation so CI can run:
//   1. promptfoo eval -o promptfoo-results.json
//   2. promptfoo-to-severity-input --in promptfoo-results.json --out severity-consistency-input.json
//   3. score:severity-consistency -- --results severity-consistency-input.json
//
// Fixture id derivation: each test passes
// vars.diff: file://fixtures/severity-calibration/<id>/diff.txt
// The <id> segment is the canonical id from manifest.json.

import { readFile, writeFile } from 'node:fs/promises';
import { z } from 'zod';

const SeverityEnum = z.enum(['info', 'minor', 'major', 'critical']);
type Severity = z.infer<typeof SeverityEnum>;

const PromptfooCommentSchema = z
  .object({
    severity: SeverityEnum,
  })
  .passthrough();

const PromptfooResponseShape = z
  .object({
    comments: z.array(PromptfooCommentSchema).optional(),
  })
  .passthrough();

const PromptfooResultRowSchema = z
  .object({
    vars: z
      .object({
        diff: z.string().optional(),
      })
      .passthrough()
      .optional(),
    response: z
      .object({
        output: z.union([PromptfooResponseShape, z.string(), z.unknown()]).optional(),
      })
      .passthrough()
      .optional(),
    output: z.union([PromptfooResponseShape, z.string(), z.unknown()]).optional(),
  })
  .passthrough();

const PromptfooResultsSchema = z
  .object({
    results: z
      .object({
        results: z.array(PromptfooResultRowSchema),
      })
      .passthrough()
      .optional(),
    flatResults: z.array(PromptfooResultRowSchema).optional(),
  })
  .passthrough();

const FIXTURE_PATH_RE = /severity-calibration\/([^/]+)\//;

export function fixtureIdFromDiff(diff: string | undefined): string | null {
  if (!diff) return null;
  const m = FIXTURE_PATH_RE.exec(diff);
  return m?.[1] ?? null;
}

function coerceOutput(raw: unknown): { severity: Severity }[] {
  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  const obj = PromptfooResponseShape.safeParse(parsed);
  if (!obj.success) return [];
  return (obj.data.comments ?? []) as { severity: Severity }[];
}

export type ScoringInput = {
  results: {
    fixtureId: string;
    runs: { comments: { severity: Severity }[] }[];
  }[];
};

export function buildScoringInput(raw: unknown): ScoringInput {
  const parsed = PromptfooResultsSchema.parse(raw);
  const rows = parsed.results?.results ?? parsed.flatResults ?? [];
  const byFixture = new Map<string, { comments: { severity: Severity }[] }[]>();
  for (const row of rows) {
    const fixtureId = fixtureIdFromDiff(row.vars?.diff);
    if (!fixtureId) continue;
    const out = row.response?.output ?? row.output;
    const comments = coerceOutput(out);
    const arr = byFixture.get(fixtureId) ?? [];
    arr.push({ comments });
    byFixture.set(fixtureId, arr);
  }
  return {
    results: [...byFixture.entries()].map(([fixtureId, runs]) => ({ fixtureId, runs })),
  };
}

function parseArgs(argv: ReadonlyArray<string>): { inPath: string; outPath: string } {
  let inPath = '';
  let outPath = '';
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--in') {
      inPath = argv[i + 1] ?? '';
      i += 1;
    } else if (a === '--out') {
      outPath = argv[i + 1] ?? '';
      i += 1;
    }
  }
  if (!inPath || !outPath) {
    throw new Error('Usage: promptfoo-to-severity-input --in <promptfoo.json> --out <input.json>');
  }
  return { inPath, outPath };
}

async function main(): Promise<void> {
  const { inPath, outPath } = parseArgs(process.argv.slice(2));
  const raw = JSON.parse(await readFile(inPath, 'utf8'));
  const out = buildScoringInput(raw);
  await writeFile(outPath, `${JSON.stringify(out, null, 2)}\n`);
  const totalRuns = out.results.reduce((acc, g) => acc + g.runs.length, 0);
  process.stdout.write(
    `wrote ${out.results.length} fixture groups (${totalRuns} runs total) to ${outPath}\n`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
