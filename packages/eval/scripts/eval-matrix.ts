#!/usr/bin/env node
// Per-provider parity matrix renderer (v1.0 #46).
//
// Reads `packages/eval/parity.json`, renders a deterministic markdown
// table to stdout, and (with --write) overwrites the matrix block in
// `docs/providers/parity-matrix.md` between the
// `<!-- BEGIN matrix -->` / `<!-- END matrix -->` markers.
//
// This script does NOT call any LLM. The actual eval measurement is
// performed by `pnpm --filter @review-agent/eval eval` per provider;
// the operator updates `parity.json` with the resulting numbers and
// re-runs this script to refresh the published doc.
//
// Usage:
//   tsx scripts/eval-matrix.ts                # print matrix to stdout
//   tsx scripts/eval-matrix.ts --write        # overwrite parity-matrix.md

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const HERE = dirname(fileURLToPath(import.meta.url));
const PARITY_PATH = join(HERE, '..', 'parity.json');
const DOC_PATH = join(HERE, '..', '..', '..', 'docs', 'providers', 'parity-matrix.md');
const BEGIN_MARKER = '<!-- BEGIN matrix -->';
const END_MARKER = '<!-- END matrix -->';

const FeatureValueSchema = z.union([
  z.literal('yes'),
  z.literal('no'),
  z.literal('json-schema'),
  z.literal('tool-fallback'),
  z.literal('endpoint-dependent'),
]);

const ProviderSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  default_model: z.string().min(1),
  features: z.object({
    prompt_caching: FeatureValueSchema,
    structured_output: FeatureValueSchema,
    tool_calling: FeatureValueSchema,
  }),
  eval: z.object({
    known_bug_precision: z.number().nullable(),
    no_issue_false_positive_rate: z.number().nullable(),
    noise_rate_delta_vs_baseline: z.number().nullable(),
  }),
  cost: z.object({
    median_pr_usd: z.number().nullable(),
    p95_latency_seconds: z.number().nullable(),
  }),
  data_retention: z.string().min(1),
});

const ParitySchema = z.object({
  version: z.literal(1),
  measured_at: z.string().nullable(),
  anthropic_baseline_model: z.string().min(1),
  providers: z.array(ProviderSchema),
  footnote: z.string().min(1),
});

type Parity = z.infer<typeof ParitySchema>;

function fmt(value: number | null, suffix = ''): string {
  if (value === null || value === undefined) return '—';
  return `${value}${suffix}`;
}

function fmtDelta(value: number | null): string {
  if (value === null || value === undefined) return '—';
  if (value === 0) return 'baseline';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value}`;
}

function renderMatrix(parity: Parity): string {
  const measuredAt = parity.measured_at ?? 'not yet measured';
  const lines: string[] = [];
  lines.push(
    `_Numbers measured: **${measuredAt}**. Baseline: \`${parity.anthropic_baseline_model}\`. See [packages/eval/parity.json](../../packages/eval/parity.json) for source data._`,
  );
  lines.push('');
  lines.push(
    '| Provider | Default model | Prompt caching | Structured output | Tool calling | Precision | FP rate | Noise Δ vs baseline | Median PR cost (USD) | p95 latency (s) | Data retention |',
  );
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|');
  for (const p of parity.providers) {
    lines.push(
      `| ${p.label} | \`${p.default_model}\` | ${p.features.prompt_caching} | ${p.features.structured_output} | ${p.features.tool_calling} | ${fmt(p.eval.known_bug_precision)} | ${fmt(p.eval.no_issue_false_positive_rate)} | ${fmtDelta(p.eval.noise_rate_delta_vs_baseline)} | ${fmt(p.cost.median_pr_usd)} | ${fmt(p.cost.p95_latency_seconds)} | ${p.data_retention} |`,
    );
  }
  lines.push('');
  lines.push(parity.footnote);
  return lines.join('\n');
}

async function loadParity(): Promise<Parity> {
  const raw = await readFile(PARITY_PATH, 'utf8');
  return ParitySchema.parse(JSON.parse(raw));
}

function replaceMatrixBlock(doc: string, matrix: string): string {
  const begin = doc.indexOf(BEGIN_MARKER);
  const end = doc.indexOf(END_MARKER);
  if (begin === -1 || end === -1 || end < begin) {
    throw new Error(
      `Markers ${BEGIN_MARKER} / ${END_MARKER} not found (or out of order) in ${DOC_PATH}.`,
    );
  }
  const head = doc.slice(0, begin + BEGIN_MARKER.length);
  const tail = doc.slice(end);
  return `${head}\n${matrix}\n${tail}`;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const parity = await loadParity();
  const matrix = renderMatrix(parity);

  if (args.includes('--write')) {
    const doc = await readFile(DOC_PATH, 'utf8');
    const updated = replaceMatrixBlock(doc, matrix);
    await writeFile(DOC_PATH, updated, 'utf8');
    process.stdout.write(`Wrote ${DOC_PATH}\n`);
    return;
  }

  process.stdout.write(`${matrix}\n`);
}

void main();
