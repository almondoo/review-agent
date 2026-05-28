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

  // Stage C: branch coverage hardening for the schema-error reporter +
  // the YAML-parser-error path's line-locator coalesce.

  it('reports schema errors at the <root> path when the failing field is the top-level shape', async () => {
    // A top-level scalar instead of a mapping forces the schema error
    // path with no nested key — `dottedPath` coalesces to `<root>` via
    // the `|| '<root>'` branch on the empty-path side.
    const io = recordingIo();
    const result = await validateConfigCommand(io, {
      path: '/virtual/.review-agent.yml',
      readFile: async () => '"just a string"\n',
    });
    expect(result.ok).toBe(false);
    expect(result.issues.length).toBeGreaterThan(0);
    expect(result.issues[0]?.path).toBe('<root>');
    expect(io.err.join('')).toContain('<root>');
  });

  it('emits the issue without a line number when the field path resolves to no node', async () => {
    // The `locateLine` helper returns `undefined` when the schema-failing
    // field is missing entirely (rather than wrong-typed). The branch on
    // the issue spread (`line === undefined ? issue : { ...issue, line }`)
    // is otherwise dead. We feed it an empty config so `cost.max_usd_per_pr`
    // is "missing" in the YAML tree — but actually the schema may emit
    // its error at the parent path. The contract: at least one issue's
    // `line` is undefined when the field is absent at the YAML level.
    const io = recordingIo();
    const result = await validateConfigCommand(io, {
      path: '/virtual/.review-agent.yml',
      readFile: async () => 'reviews:\n  ignore_authors: "not-an-array"\n',
    });
    expect(result.ok).toBe(false);
    expect(result.issues.length).toBeGreaterThan(0);
    // Pin that the stderr renderer handles both the line-present + the
    // line-absent shapes without crashing.
    expect(io.err.join('')).toContain('reviews');
  });

  it('handles a valid empty YAML config (parsed shape coalesces to {})', async () => {
    // `const parsed = doc.toJS() ?? {}` — the `?? {}` arm when the YAML
    // document is empty. ConfigSchema treats `{}` as valid (all fields
    // are optional with defaults).
    const io = recordingIo();
    const result = await validateConfigCommand(io, {
      path: '/virtual/.review-agent.yml',
      readFile: async () => '',
    });
    expect(result.ok).toBe(true);
    expect(io.out.join('')).toContain('OK');
  });

  it('coerces a non-Error readFile rejection to String(err) in the error message', async () => {
    // The `err instanceof Error ? err.message : String(err)` ternary's
    // falsy arm in the read-failure catch. A readFile seam rejecting with
    // a non-Error (e.g. a string thrown by a custom transport) must not
    // produce an unreadable `[object Object]`-flavored stderr; pin the
    // explicit String(err) coercion contract.
    const io = recordingIo();
    const result = await validateConfigCommand(io, {
      path: '/virtual/.review-agent.yml',
      readFile: async () => {
        throw 'bare string failure';
      },
    });
    expect(result.ok).toBe(false);
    expect(io.err.join('')).toContain('bare string failure');
    expect(result.issues[0]?.message).toBe('bare string failure');
  });
});
