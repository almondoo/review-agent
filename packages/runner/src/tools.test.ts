import { ToolDispatchRefusedError } from '@review-agent/core';
import { describe, expect, it, vi } from 'vitest';
import { createAiSdkToolset, createTools, dispatchTool, MAX_TOOL_CALLS } from './tools.js';

type DirentLike = {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
};

function dirent(name: string, kind: 'file' | 'dir'): DirentLike {
  return {
    name,
    isDirectory: () => kind === 'dir',
    isFile: () => kind === 'file',
  };
}

const WORKSPACE = '/work';

function makeDeps(opts: {
  files?: Record<string, string>;
  tree?: Record<string, DirentLike[]>;
  symlinks?: ReadonlyArray<string>;
}) {
  const files = opts.files ?? {};
  const tree = opts.tree ?? {};
  const symlinks = new Set(opts.symlinks ?? []);
  return {
    readFile: vi.fn(async (p: string) => {
      const value = files[p];
      if (value === undefined) throw new Error(`ENOENT ${p}`);
      return value;
    }),
    lstat: vi.fn(async (p: string) => ({
      isSymbolicLink: () => symlinks.has(p),
    })) as never,
    readdir: vi.fn(async (p: string) => tree[p] ?? []) as never,
  };
}

describe('createTools — read_file path validation', () => {
  it('reads a normal relative file', async () => {
    const tools = createTools(WORKSPACE, makeDeps({ files: { '/work/src/a.ts': 'hi' } }));
    expect(await tools.read_file({ path: 'src/a.ts' })).toBe('hi');
  });

  it('refuses absolute paths', async () => {
    const tools = createTools(WORKSPACE, makeDeps({}));
    await expect(tools.read_file({ path: '/etc/passwd' })).rejects.toBeInstanceOf(
      ToolDispatchRefusedError,
    );
  });

  it('refuses traversal that escapes the workspace', async () => {
    const tools = createTools(WORKSPACE, makeDeps({}));
    await expect(tools.read_file({ path: '../../etc/passwd' })).rejects.toBeInstanceOf(
      ToolDispatchRefusedError,
    );
  });

  it('refuses paths starting with ~', async () => {
    const tools = createTools(WORKSPACE, makeDeps({}));
    await expect(tools.read_file({ path: '~/.ssh/id_rsa' })).rejects.toBeInstanceOf(
      ToolDispatchRefusedError,
    );
  });

  it('refuses NUL bytes', async () => {
    const tools = createTools(WORKSPACE, makeDeps({}));
    await expect(tools.read_file({ path: 'a\0.ts' })).rejects.toBeInstanceOf(
      ToolDispatchRefusedError,
    );
  });

  it('refuses paths matching the deny-list (.env)', async () => {
    const tools = createTools(WORKSPACE, makeDeps({}));
    await expect(tools.read_file({ path: '.env' })).rejects.toThrow(/deny-list/);
  });

  it('refuses paths matching the deny-list (secrets/)', async () => {
    const tools = createTools(WORKSPACE, makeDeps({}));
    await expect(tools.read_file({ path: 'config/secrets/db.json' })).rejects.toThrow(/deny-list/);
  });

  it('refuses .pem files', async () => {
    const tools = createTools(WORKSPACE, makeDeps({}));
    await expect(tools.read_file({ path: 'tls/server.pem' })).rejects.toThrow(/deny-list/);
  });

  it('refuses paths whose intermediate segments are symlinks', async () => {
    const tools = createTools(
      WORKSPACE,
      makeDeps({
        files: { '/work/escape/a.ts': 'data' },
        symlinks: ['/work/escape'],
      }),
    );
    await expect(tools.read_file({ path: 'escape/a.ts' })).rejects.toThrow(/symlink/);
  });

  it('truncates oversized files', async () => {
    const big = 'x'.repeat(1_500_000);
    const tools = createTools(WORKSPACE, makeDeps({ files: { '/work/big.ts': big } }));
    const out = await tools.read_file({ path: 'big.ts' });
    expect(out.length).toBeLessThan(big.length);
    expect(out).toContain('truncated');
  });
});

describe('glob', () => {
  it('matches files relative to workspace', async () => {
    const tools = createTools(
      WORKSPACE,
      makeDeps({
        tree: {
          '/work': [dirent('src', 'dir')],
          '/work/src': [dirent('a.ts', 'file'), dirent('b.js', 'file')],
        },
      }),
    );
    const out = await tools.glob({ pattern: 'src/*.ts' });
    expect(out).toContain('src/a.ts');
    expect(out).not.toContain('src/b.js');
  });

  it('refuses traversal in patterns', async () => {
    const tools = createTools(WORKSPACE, makeDeps({}));
    await expect(tools.glob({ pattern: '../*.ts' })).rejects.toThrow(/traversal/);
  });

  it('refuses empty pattern', async () => {
    const tools = createTools(WORKSPACE, makeDeps({}));
    await expect(tools.glob({ pattern: '' })).rejects.toThrow(/empty/);
  });

  it('skips deny-listed paths during traversal', async () => {
    const tools = createTools(
      WORKSPACE,
      makeDeps({
        tree: {
          '/work': [dirent('src', 'dir'), dirent('.env', 'file')],
          '/work/src': [dirent('a.ts', 'file')],
        },
      }),
    );
    const out = await tools.glob({ pattern: '**/*' });
    expect(out).not.toContain('.env');
  });
});

describe('dispatchTool', () => {
  it('refuses unknown tool names', async () => {
    const tools = createTools(WORKSPACE, makeDeps({}));
    await expect(dispatchTool('shell_exec', {}, tools)).rejects.toBeInstanceOf(
      ToolDispatchRefusedError,
    );
  });

  it('refuses non-object args', async () => {
    const tools = createTools(WORKSPACE, makeDeps({}));
    await expect(dispatchTool('read_file', null, tools)).rejects.toThrow(/invalid args/);
  });
});

describe('createAiSdkToolset', () => {
  it('exposes the three whitelisted tools (read_file / glob / grep)', () => {
    const set = createAiSdkToolset({ workspace: WORKSPACE });
    expect(Object.keys(set).sort()).toEqual(['glob', 'grep', 'read_file']);
  });

  it('describes inputs with a Zod schema for the AI SDK', () => {
    const set = createAiSdkToolset({ workspace: WORKSPACE });
    expect(set.read_file?.inputSchema).toBeDefined();
    expect(set.glob?.inputSchema).toBeDefined();
    expect(set.grep?.inputSchema).toBeDefined();
  });

  it('fires onCall once per dispatched tool invocation', async () => {
    const onCall = vi.fn();
    const deps = makeDeps({
      files: { '/work/src/a.ts': 'hi' },
      tree: { '/work': [dirent('src', 'dir')], '/work/src': [dirent('a.ts', 'file')] },
    });
    const set = createAiSdkToolset({ workspace: WORKSPACE, toolDeps: deps, onCall });
    const readExec = set.read_file?.execute as (args: unknown, opts: unknown) => Promise<string>;
    const globExec = set.glob?.execute as (args: unknown, opts: unknown) => Promise<unknown>;
    const grepExec = set.grep?.execute as (args: unknown, opts: unknown) => Promise<unknown>;
    await readExec({ path: 'src/a.ts' }, {});
    await globExec({ pattern: 'src/*.ts' }, {});
    await grepExec({ pattern: 'hi' }, {});
    expect(onCall).toHaveBeenCalledTimes(3);
    expect(onCall.mock.calls.map((c) => c[0])).toEqual(['read_file', 'glob', 'grep']);
  });

  it('refuses deny-listed paths even through the AI-SDK wrapper', async () => {
    const set = createAiSdkToolset({ workspace: WORKSPACE, toolDeps: makeDeps({}) });
    const readExec = set.read_file?.execute as (args: unknown, opts: unknown) => Promise<string>;
    await expect(readExec({ path: '.env' }, {})).rejects.toBeInstanceOf(ToolDispatchRefusedError);
  });

  it('forwards optional grep path without injecting an undefined property', async () => {
    const deps = makeDeps({
      files: { '/work/sub/a.ts': 'foo' },
      tree: {
        '/work': [dirent('sub', 'dir')],
        '/work/sub': [dirent('a.ts', 'file')],
      },
    });
    const set = createAiSdkToolset({ workspace: WORKSPACE, toolDeps: deps });
    const grepExec = set.grep?.execute as (args: unknown, opts: unknown) => Promise<string[]>;
    // No `path` field — exercises the optional-arg branch where
    // exactOptionalPropertyTypes forbids forwarding `undefined`.
    const out = await grepExec({ pattern: 'foo' }, {});
    expect(out).toEqual(['sub/a.ts:1: foo']);
  });

  it('exposes MAX_TOOL_CALLS as a non-zero positive integer', () => {
    expect(Number.isInteger(MAX_TOOL_CALLS)).toBe(true);
    expect(MAX_TOOL_CALLS).toBeGreaterThan(0);
  });
});

describe('grep', () => {
  it('returns matching lines with line numbers', async () => {
    const tools = createTools(
      WORKSPACE,
      makeDeps({
        files: { '/work/src/a.ts': 'foo\nbar\nfoo bar\n' },
        tree: {
          '/work': [dirent('src', 'dir')],
          '/work/src': [dirent('a.ts', 'file')],
        },
      }),
    );
    const out = await tools.grep({ pattern: 'foo' });
    expect(out).toEqual(['src/a.ts:1: foo', 'src/a.ts:3: foo bar']);
  });

  it('refuses empty pattern', async () => {
    const tools = createTools(WORKSPACE, makeDeps({}));
    await expect(tools.grep({ pattern: '' })).rejects.toThrow(/empty/);
  });

  it('refuses an invalid regex (e.g. unbalanced bracket) with ToolDispatchRefusedError', async () => {
    const tools = createTools(WORKSPACE, makeDeps({}));
    // `[` is not a valid character class — `new RegExp('[')` throws SyntaxError.
    // The grep dispatch must convert that into a refusal, not let it bubble.
    await expect(tools.grep({ pattern: '[' })).rejects.toBeInstanceOf(ToolDispatchRefusedError);
    await expect(tools.grep({ pattern: '[' })).rejects.toThrow(/invalid regex/);
  });

  it('refuses patterns longer than the ReDoS guard limit', async () => {
    const tools = createTools(WORKSPACE, makeDeps({}));
    const evil = `${'a?'.repeat(120)}${'a'.repeat(120)}`;
    await expect(tools.grep({ pattern: evil })).rejects.toBeInstanceOf(ToolDispatchRefusedError);
    await expect(tools.grep({ pattern: evil })).rejects.toThrow(/pattern too long/);
  });
});
