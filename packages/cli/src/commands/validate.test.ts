import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { validateConfigCommand } from './validate.js';

function recordingIo() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    stdout: (c: string) => {
      out.push(c);
    },
    stderr: (c: string) => {
      err.push(c);
    },
    exit: () => {},
  };
}

describe('validateConfigCommand', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'review-agent-cli-validate-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports OK for a valid file (real fixture YAML)', async () => {
    const path = join(dir, '.review-agent.yml');
    writeFileSync(
      path,
      [
        'language: ja-JP',
        'profile: assertive',
        'cost:',
        '  max_usd_per_pr: 2.0',
        'reviews:',
        '  auto_review:',
        '    drafts: false',
        '  ignore_authors: ["dependabot[bot]"]',
        '  path_instructions:',
        '    - path: "**/*.ts"',
        '      instructions: "TS-only review."',
      ].join('\n'),
    );

    const io = recordingIo();
    const result = await validateConfigCommand(io, { path });
    expect(result.ok).toBe(true);
    expect(io.out.join('')).toContain('OK');
    expect(io.err).toEqual([]);
  });

  it('reports schema errors with line numbers', async () => {
    const path = join(dir, '.review-agent.yml');
    // language must be a supported BCP-47 string; nonsense triggers schema fail.
    writeFileSync(path, ['language: 12345', 'profile: assertive'].join('\n'));

    const io = recordingIo();
    const result = await validateConfigCommand(io, { path });
    expect(result.ok).toBe(false);
    expect(result.issues.length).toBeGreaterThan(0);
    const issue = result.issues[0];
    expect(issue?.path).toBe('language');
    expect(typeof issue?.line).toBe('number');
    expect(io.err.join('')).toContain('language');
  });

  it('reports YAML parse errors with line numbers', async () => {
    const path = join(dir, '.review-agent.yml');
    writeFileSync(
      path,
      ['language: en-US', '  - this is not valid', 'profile: assertive'].join('\n'),
    );

    const io = recordingIo();
    const result = await validateConfigCommand(io, { path });
    expect(result.ok).toBe(false);
    expect(result.issues.length).toBeGreaterThan(0);
    expect(io.err.join('')).toContain('Invalid');
  });

  it('reports a missing file with a clear error', async () => {
    const io = recordingIo();
    const result = await validateConfigCommand(io, {
      path: join(dir, 'does-not-exist.yml'),
    });
    expect(result.ok).toBe(false);
    expect(io.err.join('')).toContain('Failed to read');
  });

  it('uses an injected reader when supplied', async () => {
    const io = recordingIo();
    const result = await validateConfigCommand(io, {
      path: '/virtual/.review-agent.yml',
      readFile: async () => 'language: en-US\nprofile: chill\n',
    });
    expect(result.ok).toBe(true);
  });
});
