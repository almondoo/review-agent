import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validateFixtures } from '../severity-consistency-validate.js';

const MIN_FIXTURES = 5;

async function buildValidFixtureSet(dir: string): Promise<void> {
  const manifest = {
    version: 1,
    description: 'temp set for tests',
    n_runs_per_fixture: 3,
    stability_threshold: 0.66,
    fixtures: Array.from({ length: MIN_FIXTURES }, (_v, i) => ({
      id: `${String(i + 1).padStart(2, '0')}-fix-${i}`,
      category: 'bug',
      expected_severity_modal: 'major' as const,
    })),
  };
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  for (const entry of manifest.fixtures) {
    const fdir = join(dir, entry.id);
    await mkdir(fdir, { recursive: true });
    await writeFile(
      join(fdir, 'diff.txt'),
      '--- a/x.ts\n+++ b/x.ts\n@@ -1,1 +1,1 @@\n-old\n+new\n',
    );
    await writeFile(
      join(fdir, 'expected.json'),
      JSON.stringify({
        category: 'severity-calibration',
        bug_class: 'test',
        language: 'TypeScript',
        severity_min: 'minor',
        severity_max: 'critical',
        severity_modal: 'major',
        rationale: 'test rationale',
      }),
    );
    await writeFile(join(fdir, 'README.md'), `# ${entry.id}\n`);
  }
}

describe('validateFixtures', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'sev-fixture-test-'));
    await buildValidFixtureSet(dir);
  });

  afterAll(() => {
    // The tmpdir cleanup is best-effort — vitest's process teardown takes
    // care of leftover entries, and explicit rm-rf adds noise without
    // value on CI containers that get wiped between runs.
  });

  it('accepts a well-formed fixture set', async () => {
    const out = await validateFixtures(dir);
    expect(out.errors).toEqual([]);
    expect(out.fixturesValidated).toBe(MIN_FIXTURES);
  });

  it('reports missing diff.txt', async () => {
    const orphanDir = await mkdtemp(join(tmpdir(), 'sev-orphan-'));
    await buildValidFixtureSet(orphanDir);
    // Delete diff.txt of the first fixture by overwriting expected.json
    // alone — easier: just create a brand-new dir with a manifest entry
    // pointing at an empty subdir.
    const broken = {
      version: 1,
      description: 'broken',
      n_runs_per_fixture: 3,
      stability_threshold: 0.66,
      fixtures: Array.from({ length: MIN_FIXTURES }, (_v, i) => ({
        id: `${String(i + 1).padStart(2, '0')}-broken-${i}`,
        category: 'bug',
        expected_severity_modal: 'major' as const,
      })),
    };
    await writeFile(join(orphanDir, 'manifest.json'), JSON.stringify(broken));
    for (const f of broken.fixtures) await mkdir(join(orphanDir, f.id), { recursive: true });
    const out = await validateFixtures(orphanDir);
    expect(out.errors.length).toBeGreaterThan(0);
    expect(out.errors.some((e) => e.includes('missing diff.txt'))).toBe(true);
    expect(out.errors.some((e) => e.includes('missing expected.json'))).toBe(true);
    expect(out.errors.some((e) => e.includes('missing README.md'))).toBe(true);
  });

  it('reports orphan directories not declared in manifest', async () => {
    const dir2 = await mkdtemp(join(tmpdir(), 'sev-orphan2-'));
    await buildValidFixtureSet(dir2);
    await mkdir(join(dir2, 'aa-orphan-fixture'), { recursive: true });
    const out = await validateFixtures(dir2);
    expect(out.errors.some((e) => e.includes('not in manifest.json'))).toBe(true);
  });

  it('reports manifest entry without a directory on disk', async () => {
    const dir3 = await mkdtemp(join(tmpdir(), 'sev-missing-dir-'));
    const manifest = {
      version: 1,
      description: 'missing-dir',
      n_runs_per_fixture: 3,
      stability_threshold: 0.66,
      fixtures: Array.from({ length: MIN_FIXTURES }, (_v, i) => ({
        id: `${String(i + 1).padStart(2, '0')}-ghost-${i}`,
        category: 'bug',
        expected_severity_modal: 'major' as const,
      })),
    };
    await writeFile(join(dir3, 'manifest.json'), JSON.stringify(manifest));
    const out = await validateFixtures(dir3);
    expect(
      out.errors.some((e) => e.includes('declared in manifest but no directory on disk')),
    ).toBe(true);
  });

  it('reports modal mismatch between manifest and expected.json', async () => {
    const dir4 = await mkdtemp(join(tmpdir(), 'sev-mismatch-'));
    const manifest = {
      version: 1,
      description: 'mismatch',
      n_runs_per_fixture: 3,
      stability_threshold: 0.66,
      fixtures: Array.from({ length: MIN_FIXTURES }, (_v, i) => ({
        id: `${String(i + 1).padStart(2, '0')}-mm-${i}`,
        category: 'bug',
        expected_severity_modal: 'minor' as const,
      })),
    };
    await writeFile(join(dir4, 'manifest.json'), JSON.stringify(manifest));
    for (const entry of manifest.fixtures) {
      const fdir = join(dir4, entry.id);
      await mkdir(fdir, { recursive: true });
      await writeFile(
        join(fdir, 'diff.txt'),
        '--- a/x.ts\n+++ b/x.ts\n@@ -1,1 +1,1 @@\n-old\n+new\n',
      );
      await writeFile(
        join(fdir, 'expected.json'),
        JSON.stringify({
          category: 'severity-calibration',
          bug_class: 'test',
          language: 'TypeScript',
          severity_min: 'info',
          severity_max: 'critical',
          // Mismatch: manifest says minor, expected says major.
          severity_modal: 'major',
          rationale: 'mismatch test',
        }),
      );
      await writeFile(join(fdir, 'README.md'), `# ${entry.id}\n`);
    }
    const out = await validateFixtures(dir4);
    expect(out.errors.some((e) => e.includes('does not match expected.json'))).toBe(true);
  });
});
