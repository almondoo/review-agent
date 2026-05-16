import { describe, expect, it, vi } from 'vitest';
import {
  collectAutoFetchContext,
  DEFAULT_AUTO_FETCH_BUDGET,
  type PathInstructionWithFetch,
  renderRelatedFiles,
} from './auto-fetch.js';

type DirentLike = {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
};

function makeDeps(opts: { files?: Record<string, string>; symlinks?: ReadonlyArray<string> }) {
  const files = opts.files ?? {};
  const symlinks = new Set(opts.symlinks ?? []);
  return {
    readFile: vi.fn(async (p: string) => {
      const v = files[p];
      if (v === undefined) throw new Error(`ENOENT ${p}`);
      return v;
    }),
    lstat: vi.fn(async (p: string) => ({
      isSymbolicLink: () => symlinks.has(p),
    })) as never,
    readdir: vi.fn(async (): Promise<DirentLike[]> => []) as never,
  };
}

const WORKSPACE = '/work';

describe('collectAutoFetchContext — no-op paths', () => {
  it('returns an empty result when workspaceDir is empty (Server "none" strategy)', async () => {
    const result = await collectAutoFetchContext({
      changedPaths: ['src/a.ts'],
      pathInstructions: [{ pattern: 'src/*.ts', text: 'x', autoFetch: { tests: true } }],
      workspaceDir: '',
    });
    expect(result.files).toEqual([]);
    expect(result.totalBytes).toBe(0);
    expect(result.hitBudgetLimit).toBe(false);
  });

  it('returns empty when no path_instruction has autoFetch configured', async () => {
    const result = await collectAutoFetchContext({
      changedPaths: ['src/a.ts'],
      pathInstructions: [{ pattern: 'src/*.ts', text: 'x' }],
      workspaceDir: WORKSPACE,
      toolDeps: makeDeps({}),
    });
    expect(result.files).toEqual([]);
  });

  it('returns empty when changedPaths is empty', async () => {
    const result = await collectAutoFetchContext({
      changedPaths: [],
      pathInstructions: [{ pattern: 'src/*.ts', text: 'x', autoFetch: { tests: true } }],
      workspaceDir: WORKSPACE,
      toolDeps: makeDeps({}),
    });
    expect(result.files).toEqual([]);
  });

  it('returns empty when a path_instruction has an unparseable glob pattern', async () => {
    const NUL = String.fromCharCode(0);
    const result = await collectAutoFetchContext({
      changedPaths: ['src/a.ts'],
      pathInstructions: [{ pattern: `src/${NUL}.ts`, text: 'x', autoFetch: { tests: true } }],
      workspaceDir: WORKSPACE,
      toolDeps: makeDeps({ files: { '/work/src/a.test.ts': 'test' } }),
    });
    // Invalid glob → silently dropped; no fetches happen.
    expect(result.files).toEqual([]);
  });
});

describe('collectAutoFetchContext — happy paths', () => {
  it('fetches the test companion (autoFetch.tests=true) for a changed file matching the pattern', async () => {
    const deps = makeDeps({
      files: {
        '/work/src/foo.test.ts': "import { foo } from './foo';\ntest('foo', () => {});",
      },
    });
    const result = await collectAutoFetchContext({
      changedPaths: ['src/foo.ts'],
      pathInstructions: [
        { pattern: 'src/**/*.ts', text: 'x', autoFetch: { tests: true, types: false } },
      ],
      workspaceDir: WORKSPACE,
      toolDeps: deps,
    });
    expect(result.files).toHaveLength(1);
    expect(result.files[0]?.path).toBe('src/foo.test.ts');
    expect(result.files[0]?.kind).toBe('test');
    expect(result.files[0]?.originatingChangedPath).toBe('src/foo.ts');
  });

  it('fetches the .d.ts companion when autoFetch.types=true', async () => {
    const deps = makeDeps({
      files: { '/work/src/foo.d.ts': 'export declare function foo(): void;' },
    });
    const result = await collectAutoFetchContext({
      changedPaths: ['src/foo.ts'],
      pathInstructions: [
        { pattern: 'src/**/*.ts', text: 'x', autoFetch: { tests: false, types: true } },
      ],
      workspaceDir: WORKSPACE,
      toolDeps: deps,
    });
    expect(result.files).toHaveLength(1);
    expect(result.files[0]?.path).toBe('src/foo.d.ts');
    expect(result.files[0]?.kind).toBe('type');
  });

  it("skips the test companion for a file that is itself a test (changed='src/foo.test.ts')", async () => {
    const deps = makeDeps({
      // If we wrongly tried `src/foo.test.test.ts` we'd 404. Pin the
      // skip behavior by leaving the companion absent.
      files: {},
    });
    const result = await collectAutoFetchContext({
      changedPaths: ['src/foo.test.ts'],
      pathInstructions: [{ pattern: 'src/**/*.ts', text: 'x', autoFetch: { tests: true } }],
      workspaceDir: WORKSPACE,
      toolDeps: deps,
    });
    expect(result.files).toEqual([]);
  });

  it('skips the type companion for a file that is itself a .d.ts', async () => {
    const deps = makeDeps({ files: {} });
    const result = await collectAutoFetchContext({
      changedPaths: ['src/foo.d.ts'],
      pathInstructions: [{ pattern: 'src/**/*.ts', text: 'x', autoFetch: { types: true } }],
      workspaceDir: WORKSPACE,
      toolDeps: deps,
    });
    expect(result.files).toEqual([]);
  });

  it('silently skips a non-existent companion (no throw)', async () => {
    const deps = makeDeps({ files: {} });
    const result = await collectAutoFetchContext({
      changedPaths: ['src/foo.ts'],
      pathInstructions: [
        { pattern: 'src/**/*.ts', text: 'x', autoFetch: { tests: true, types: true } },
      ],
      workspaceDir: WORKSPACE,
      toolDeps: deps,
    });
    expect(result.files).toEqual([]);
    expect(result.hitBudgetLimit).toBe(false);
  });

  it('refuses denylisted companion paths (defense-in-depth via tools.read_file)', async () => {
    // If a path_instruction matched `.env` somehow and the operator
    // turned on autoFetch, the underlying read_file still refuses.
    // (The schema rejects `.env*` via deny-list paths in tools.ts.)
    const deps = makeDeps({ files: { '/work/.env.test.': 'SECRET=1' } });
    const result = await collectAutoFetchContext({
      changedPaths: ['.env'],
      pathInstructions: [{ pattern: '*', text: 'x', autoFetch: { tests: true } }],
      workspaceDir: WORKSPACE,
      toolDeps: deps,
    });
    // No file fetched — `.env.test` is deny-listed by tools.ts.
    expect(result.files).toEqual([]);
  });
});

describe('collectAutoFetchContext — budget caps', () => {
  it('stops at maxFiles', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 10; i++) {
      files[`/work/src/f${i}.test.ts`] = 'test';
      files[`/work/src/f${i}.d.ts`] = 'decl';
    }
    const deps = makeDeps({ files });
    const changedPaths = Array.from({ length: 10 }, (_, i) => `src/f${i}.ts`);
    const result = await collectAutoFetchContext({
      changedPaths,
      pathInstructions: [
        { pattern: 'src/**/*.ts', text: 'x', autoFetch: { tests: true, types: true } },
      ],
      workspaceDir: WORKSPACE,
      toolDeps: deps,
      budget: { maxFiles: 3 },
    });
    expect(result.files).toHaveLength(3);
    expect(result.hitBudgetLimit).toBe(true);
  });

  it('truncates the last file to fit maxTotalBytes (no wholesale skip on overflow)', async () => {
    const big = 'x'.repeat(200);
    const deps = makeDeps({
      files: {
        '/work/src/a.test.ts': big,
        '/work/src/b.test.ts': big,
      },
    });
    const result = await collectAutoFetchContext({
      changedPaths: ['src/a.ts', 'src/b.ts'],
      pathInstructions: [
        { pattern: 'src/**/*.ts', text: 'x', autoFetch: { tests: true, types: false } },
      ],
      workspaceDir: WORKSPACE,
      toolDeps: deps,
      budget: { maxBytesPerFile: 500, maxTotalBytes: 250 },
    });
    expect(result.files).toHaveLength(2);
    expect(result.totalBytes).toBe(250);
    // Second file trimmed to the remaining 50-byte headroom.
    expect(result.files[1]?.content.length).toBe(50);
    expect(result.hitBudgetLimit).toBe(true);
  });

  it('per-file truncation kicks in for individually large files', async () => {
    const huge = 'x'.repeat(2_000);
    const deps = makeDeps({
      files: { '/work/src/a.test.ts': huge },
    });
    const result = await collectAutoFetchContext({
      changedPaths: ['src/a.ts'],
      pathInstructions: [{ pattern: 'src/**/*.ts', text: 'x', autoFetch: { tests: true } }],
      workspaceDir: WORKSPACE,
      toolDeps: deps,
      budget: { maxBytesPerFile: 100 },
    });
    expect(result.files).toHaveLength(1);
    expect(result.files[0]?.content).toContain('[...truncated at 100 chars]');
  });

  it('exposes the default budget as DEFAULT_AUTO_FETCH_BUDGET', () => {
    expect(DEFAULT_AUTO_FETCH_BUDGET).toEqual({
      maxFiles: 5,
      maxBytesPerFile: 50_000,
      maxTotalBytes: 250_000,
    });
  });
});

describe('collectAutoFetchContext — multi-instruction precedence', () => {
  it('only counts the first matching instruction per changed file', async () => {
    // Two patterns both match `src/foo.ts`. The first one's
    // autoFetch is the only one applied. This is the documented
    // precedence: order in `.review-agent.yml` wins.
    const deps = makeDeps({
      files: {
        '/work/src/foo.test.ts': 'test',
        '/work/src/foo.d.ts': 'decl',
      },
    });
    const result = await collectAutoFetchContext({
      changedPaths: ['src/foo.ts'],
      pathInstructions: [
        { pattern: 'src/**/*.ts', text: 'first', autoFetch: { tests: true, types: false } },
        { pattern: 'src/foo.ts', text: 'second', autoFetch: { tests: false, types: true } },
      ] as ReadonlyArray<PathInstructionWithFetch>,
      workspaceDir: WORKSPACE,
      toolDeps: deps,
    });
    // Only the test file (from the first instruction). The d.ts
    // (from the second) is NOT fetched.
    expect(result.files).toHaveLength(1);
    expect(result.files[0]?.path).toBe('src/foo.test.ts');
  });
});

describe('renderRelatedFiles', () => {
  it('returns the empty string when no files were fetched', () => {
    expect(renderRelatedFiles({ files: [], totalBytes: 0, hitBudgetLimit: false })).toBe('');
  });

  it('wraps each file in a <related_file> child with sha-style attributes', () => {
    const out = renderRelatedFiles({
      files: [
        {
          path: 'src/foo.test.ts',
          content: 'test content',
          kind: 'test',
          originatingChangedPath: 'src/foo.ts',
        },
      ],
      totalBytes: 12,
      hitBudgetLimit: false,
    });
    expect(out).toContain('<related_files>');
    expect(out).toContain(
      '<related_file path="src/foo.test.ts" kind="test" matched_changed="src/foo.ts">',
    );
    expect(out).toContain('test content');
    expect(out).toContain('</related_file>');
    expect(out).toContain('</related_files>');
    // No budget marker when budget wasn't hit.
    expect(out).not.toContain('budget reached');
  });

  it('appends a trailing comment when the budget was hit', () => {
    const out = renderRelatedFiles({
      files: [
        {
          path: 'src/a.test.ts',
          content: 'x',
          kind: 'test',
          originatingChangedPath: 'src/a.ts',
        },
      ],
      totalBytes: 1,
      hitBudgetLimit: true,
    });
    expect(out).toContain('budget reached');
    expect(out).toContain('1 file(s) materialized (1 bytes)');
  });
});
