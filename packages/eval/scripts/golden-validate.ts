#!/usr/bin/env node
// Golden fixture sanity check (spec §14.4).
//
// Walks every fixture under packages/eval/fixtures/golden/ and
// asserts:
//   - every directory listed in manifest.json exists on disk;
//   - every fixture directory contains diff.txt + expected.json;
//   - expected.json parses against the per-category Zod schema;
//   - the diff is a real unified diff;
//   - per-category counts match the §14.4 targets.
//
// Runs on every PR via the standard test job. Cheap (no LLM call).
// The expensive eval ("does the agent actually produce the right
// output?") runs in `.github/workflows/golden-eval.yml`.

import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(HERE, '..', 'fixtures', 'golden');

const ManifestSchema = z.object({
  version: z.number().int().positive(),
  description: z.string(),
  fixtures: z.array(
    z.object({
      id: z.string().regex(/^[a-z0-9-]+\/[a-z0-9-]+$/),
      category: z.enum(['known-bug', 'no-issue', 'large-diff', 'incremental', 'multi-language']),
    }),
  ),
});

const ExpectedBase = z.object({
  category: z.enum(['known-bug', 'no-issue', 'large-diff', 'incremental', 'multi-language']),
  rationale: z.string().min(1),
});

const PerCategoryTargets: Record<string, number> = {
  'known-bug': 20,
  'no-issue': 12,
  'large-diff': 5,
  incremental: 3,
  'multi-language': 5,
};

async function readJson<T>(path: string, schema: z.ZodType<T>): Promise<T> {
  const raw = await readFile(path, 'utf8');
  return schema.parse(JSON.parse(raw));
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const manifest = await readJson(join(FIXTURES_DIR, 'manifest.json'), ManifestSchema);
  const errors: string[] = [];

  // Per-fixture shape validation.
  for (const f of manifest.fixtures) {
    const dir = join(FIXTURES_DIR, f.id);
    for (const file of ['diff.txt', 'expected.json']) {
      if (!(await exists(join(dir, file)))) {
        errors.push(`${f.id}: missing ${file}`);
      }
    }
    if (await exists(join(dir, 'expected.json'))) {
      try {
        const expected = await readJson(join(dir, 'expected.json'), ExpectedBase.passthrough());
        if (expected.category !== f.category) {
          errors.push(
            `${f.id}: expected.json category='${expected.category}' does not match manifest category='${f.category}'`,
          );
        }
      } catch (err) {
        errors.push(`${f.id}: expected.json invalid (${(err as Error).message})`);
      }
    }
    if (await exists(join(dir, 'diff.txt'))) {
      const diff = await readFile(join(dir, 'diff.txt'), 'utf8');
      if (!/^---\s/m.test(diff) || !/^\+\+\+\s/m.test(diff)) {
        errors.push(`${f.id}: diff.txt is not a unified diff (missing --- / +++ headers)`);
      }
    }
  }

  // Cross-check on-disk dirs vs manifest entries.
  for (const category of Object.keys(PerCategoryTargets)) {
    const dir = join(FIXTURES_DIR, category);
    if (!(await exists(dir))) continue;
    const onDisk = (await readdir(dir, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => `${category}/${d.name}`);
    const declared = new Set(manifest.fixtures.map((f) => f.id));
    for (const id of onDisk) {
      if (!declared.has(id)) errors.push(`${id}: directory exists but is not in manifest.json`);
    }
  }

  // Per-category count gate (§14.4 targets).
  const counts: Record<string, number> = {};
  for (const f of manifest.fixtures) {
    counts[f.category] = (counts[f.category] ?? 0) + 1;
  }
  for (const [category, target] of Object.entries(PerCategoryTargets)) {
    const have = counts[category] ?? 0;
    if (have < target) {
      errors.push(`category '${category}': ${have} fixtures, target ${target} (spec §14.4)`);
    }
  }

  const total = manifest.fixtures.length;
  if (errors.length > 0) {
    process.stderr.write(`Golden fixture validation failed:\n  - ${errors.join('\n  - ')}\n`);
    process.exit(1);
  }
  process.stdout.write(
    `OK: ${total} golden fixtures validated.\n` +
      `  known-bug=${counts['known-bug'] ?? 0} no-issue=${counts['no-issue'] ?? 0} ` +
      `large-diff=${counts['large-diff'] ?? 0} incremental=${counts.incremental ?? 0} ` +
      `multi-language=${counts['multi-language'] ?? 0}\n`,
  );
}

void main();
