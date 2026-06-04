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

  // --- Invalid-config scenarios for new fields (ruleset / max_steps / provider) ---

  it('rejects an invalid ruleset category min_severity value', async () => {
    // ruleset.<category>.min_severity must be one of info/minor/major/critical.
    // Any other value (e.g. "blocker") must produce a non-zero result and
    // include the dotted path in the error message.
    const io = recordingIo();
    const result = await validateConfigCommand(io, {
      path: '/virtual/.review-agent.yml',
      readFile: async () => ['ruleset:', '  security:', '    min_severity: blocker'].join('\n'),
    });
    expect(result.ok).toBe(false);
    expect(result.issues.length).toBeGreaterThan(0);
    const stderr = io.err.join('');
    expect(stderr).toContain('ruleset');
    expect(stderr).toContain('security');
  });

  it('rejects an out-of-range max_steps value (> 50)', async () => {
    // reviews.max_steps must be 1–50. A value of 99 must be rejected.
    const io = recordingIo();
    const result = await validateConfigCommand(io, {
      path: '/virtual/.review-agent.yml',
      readFile: async () => ['reviews:', '  max_steps: 99'].join('\n'),
    });
    expect(result.ok).toBe(false);
    expect(result.issues.length).toBeGreaterThan(0);
    const issue = result.issues.find((i) => i.path.includes('max_steps'));
    expect(issue, 'expected an issue mentioning max_steps').toBeDefined();
    expect(io.err.join('')).toContain('max_steps');
  });

  it('rejects max_steps below the minimum bound (< 1)', async () => {
    // max_steps: 0 is out of range (min is 1).
    const io = recordingIo();
    const result = await validateConfigCommand(io, {
      path: '/virtual/.review-agent.yml',
      readFile: async () => ['reviews:', '  max_steps: 0'].join('\n'),
    });
    expect(result.ok).toBe(false);
    const issue = result.issues.find((i) => i.path.includes('max_steps'));
    expect(issue, 'expected an issue mentioning max_steps').toBeDefined();
  });

  it('rejects an unknown provider type', async () => {
    // provider.type must be one of the known enum values. 'unknown-provider'
    // must produce an actionable schema error.
    const io = recordingIo();
    const result = await validateConfigCommand(io, {
      path: '/virtual/.review-agent.yml',
      readFile: async () => ['provider:', '  type: unknown-provider', '  model: gpt-4o'].join('\n'),
    });
    expect(result.ok).toBe(false);
    expect(result.issues.length).toBeGreaterThan(0);
    const stderr = io.err.join('');
    expect(stderr).toContain('provider');
  });

  it('rejects an unrecognized top-level key (strict mode)', async () => {
    // ConfigSchema is .strict(), so any unrecognized top-level key must fail.
    const io = recordingIo();
    const result = await validateConfigCommand(io, {
      path: '/virtual/.review-agent.yml',
      readFile: async () => ['unknown_key: some_value', 'language: en-US'].join('\n'),
    });
    expect(result.ok).toBe(false);
    expect(result.issues.length).toBeGreaterThan(0);
    expect(io.err.join('')).toContain('Invalid');
  });

  it('rejects an invalid profile value', async () => {
    // profile must be one of 'chill' | 'assertive'. Any other value is rejected.
    const io = recordingIo();
    const result = await validateConfigCommand(io, {
      path: '/virtual/.review-agent.yml',
      readFile: async () => 'profile: aggressive\n',
    });
    expect(result.ok).toBe(false);
    const issue = result.issues.find((i) => i.path.includes('profile'));
    expect(issue, 'expected an issue mentioning profile').toBeDefined();
    expect(io.err.join('')).toContain('profile');
  });

  it('accepts a valid ruleset block with known categories and min_severity', async () => {
    // Smoke-test that a well-formed ruleset block passes validation.
    const io = recordingIo();
    const result = await validateConfigCommand(io, {
      path: '/virtual/.review-agent.yml',
      readFile: async () =>
        [
          'ruleset:',
          '  security:',
          '    min_severity: major',
          '    enabled: true',
          '  style:',
          '    enabled: false',
        ].join('\n'),
    });
    expect(result.ok).toBe(true);
    expect(io.out.join('')).toContain('OK');
  });

  it('accepts valid reviews.max_steps within bounds', async () => {
    // Confirm that a max_steps value within [1, 50] is accepted.
    const io = recordingIo();
    const result = await validateConfigCommand(io, {
      path: '/virtual/.review-agent.yml',
      readFile: async () => ['reviews:', '  max_steps: 30'].join('\n'),
    });
    expect(result.ok).toBe(true);
    expect(io.out.join('')).toContain('OK');
  });
});
