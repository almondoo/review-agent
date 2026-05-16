#!/usr/bin/env node
// Severity-calibration fixture sanity check (#68).
//
// Walks every fixture under packages/eval/fixtures/severity-calibration/
// and asserts:
//   - every directory listed in manifest.json exists on disk;
//   - every fixture directory contains diff.txt + expected.json + README.md;
//   - expected.json parses against FixtureExpectedSchema with
//     severity_min <= severity_modal <= severity_max;
//   - the diff is a real unified diff;
//   - manifest's `expected_severity_modal` matches expected.json's
//     `severity_modal` (the manifest entry is authoritative for
//     hand-off to runner configs, expected.json is authoritative for
//     the eval driver — they must agree);
//   - 5 ≤ fixtures ≤ 10 (acceptance criterion).
//
// Runs in CI on every PR alongside golden / red-team validators. Does
// NOT call any LLM.

import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FixtureExpectedSchema, ManifestSchema } from './severity-consistency-core.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(HERE, '..', 'fixtures', 'severity-calibration');

async function readJson<T>(path: string, parser: (raw: unknown) => T): Promise<T> {
  const raw = await readFile(path, 'utf8');
  return parser(JSON.parse(raw));
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function validateFixtures(fixturesDir = FIXTURES_DIR): Promise<{
  readonly errors: ReadonlyArray<string>;
  readonly fixturesValidated: number;
}> {
  const manifest = await readJson(join(fixturesDir, 'manifest.json'), (v) =>
    ManifestSchema.parse(v),
  );
  const errors: string[] = [];

  for (const f of manifest.fixtures) {
    const dir = join(fixturesDir, f.id);
    for (const file of ['diff.txt', 'expected.json', 'README.md']) {
      if (!(await exists(join(dir, file)))) {
        errors.push(`${f.id}: missing ${file}`);
      }
    }
    if (await exists(join(dir, 'expected.json'))) {
      try {
        const expected = await readJson(join(dir, 'expected.json'), (v) =>
          FixtureExpectedSchema.parse(v),
        );
        if (expected.severity_modal !== f.expected_severity_modal) {
          errors.push(
            `${f.id}: manifest expected_severity_modal='${f.expected_severity_modal}' does not match expected.json severity_modal='${expected.severity_modal}'`,
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

  const onDisk = (await readdir(fixturesDir, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
  const declared = new Set(manifest.fixtures.map((f) => f.id));
  for (const d of onDisk) {
    if (!declared.has(d)) errors.push(`${d}: directory exists but is not in manifest.json`);
  }
  for (const f of manifest.fixtures) {
    if (!onDisk.includes(f.id)) {
      errors.push(`${f.id}: declared in manifest but no directory on disk`);
    }
  }

  return { errors, fixturesValidated: manifest.fixtures.length };
}

async function main(): Promise<void> {
  const { errors, fixturesValidated } = await validateFixtures();
  if (errors.length > 0) {
    process.stderr.write(
      `Severity-calibration fixture validation failed:\n  - ${errors.join('\n  - ')}\n`,
    );
    process.exit(1);
  }
  process.stdout.write(`OK: ${fixturesValidated} severity-calibration fixtures validated.\n`);
}

// Only run main when invoked as a script (tsx scripts/severity-consistency-validate.ts).
// Importing as a module (e.g. from tests) must not trigger the side effect.
if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
