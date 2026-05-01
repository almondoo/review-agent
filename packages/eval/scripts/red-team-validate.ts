#!/usr/bin/env node
// Red-team fixture sanity check (spec §7.3 #7).
//
// Walks every fixture under packages/eval/fixtures/red-team/ and
// asserts:
//
//   - every directory listed in manifest.json exists on disk;
//   - every fixture directory contains diff.txt + pr-meta.json +
//     expected.json + README.md;
//   - pr-meta.json parses and has at least `title`, `body`,
//     `author`, `base_ref`, `head_ref`;
//   - expected.json parses and carries `category` + `attack` +
//     either `must_not_contain` or `must_contain_any` (or both);
//   - the diff is a non-empty unified diff (starts with --- / +++).
//
// This does NOT run the agent — that's the slower CI job
// (`.github/workflows/red-team-eval.yml`). This validator runs on
// every PR via the standard `pnpm test` and catches fixture-shape
// breakage before the expensive eval kicks in.

import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(HERE, '..', 'fixtures', 'red-team');

const ManifestSchema = z.object({
  version: z.number().int().positive(),
  description: z.string(),
  fixtures: z.array(
    z.object({
      id: z.string().regex(/^\d{2}-[a-z0-9-]+$/),
      category: z.string(),
      reference: z.string().optional(),
    }),
  ),
});

const PrMetaSchema = z
  .object({
    title: z.string().min(1),
    body: z.string(),
    author: z.string().min(1),
    base_ref: z.string().min(1),
    head_ref: z.string().min(1),
  })
  .passthrough();

const ExpectedSchema = z
  .object({
    category: z.literal('red-team'),
    attack: z.string().min(1),
    rationale: z.string().min(1),
    must_not_contain: z.array(z.string()).optional(),
    must_contain_any: z.array(z.string()).optional(),
    should_flag: z.boolean().optional(),
    reference: z.string().optional(),
  })
  .refine((v) => v.must_not_contain || v.must_contain_any, {
    message: 'expected.json must declare must_not_contain and/or must_contain_any',
  });

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

  for (const f of manifest.fixtures) {
    const dir = join(FIXTURES_DIR, f.id);
    for (const file of ['diff.txt', 'pr-meta.json', 'expected.json', 'README.md']) {
      if (!(await exists(join(dir, file)))) {
        errors.push(`${f.id}: missing ${file}`);
      }
    }
    if (await exists(join(dir, 'pr-meta.json'))) {
      try {
        await readJson(join(dir, 'pr-meta.json'), PrMetaSchema);
      } catch (err) {
        errors.push(`${f.id}: pr-meta.json invalid (${(err as Error).message})`);
      }
    }
    if (await exists(join(dir, 'expected.json'))) {
      try {
        await readJson(join(dir, 'expected.json'), ExpectedSchema);
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
  const onDisk = (await readdir(FIXTURES_DIR, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
  const declared = new Set(manifest.fixtures.map((f) => f.id));
  for (const d of onDisk) {
    if (!declared.has(d)) errors.push(`${d}: directory exists but is not in manifest.json`);
  }
  for (const f of manifest.fixtures) {
    if (!onDisk.includes(f.id))
      errors.push(`${f.id}: declared in manifest but no directory on disk`);
  }

  if (errors.length > 0) {
    process.stderr.write(`Red-team fixture validation failed:\n  - ${errors.join('\n  - ')}\n`);
    process.exit(1);
  }
  process.stdout.write(`OK: ${manifest.fixtures.length} red-team fixtures validated.\n`);
}

void main();
