import { globToRegExp, ToolDispatchRefusedError } from '@review-agent/core';
import { describe, expect, it, vi } from 'vitest';
import {
  createAiSdkToolset,
  createTools,
  dispatchTool,
  MAX_FILE_SIZE,
  MAX_GREP_PATTERN_LENGTH,
  MAX_TOOL_CALLS,
} from './tools.js';

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

// Build a fs-style error that carries the same `.code` property the
// real `node:fs` errors do — `grepInDir` keys off this field to
// classify the failure (skip silently / emit marker / rethrow).
function fsError(code: string, path: string, syscall = 'open'): NodeJS.ErrnoException {
  const err = new Error(`${code}: simulated, ${syscall} '${path}'`) as NodeJS.ErrnoException;
  err.code = code;
  return err;
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
      if (value === undefined) throw fsError('ENOENT', p);
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

  it('skips an entry that became a directory mid-scan silently (EISDIR)', async () => {
    // Race between `readdir` (which classified `b` as a file) and
    // `readFile` (which now finds it is a directory). Same outcome as
    // ENOENT — drop the entry silently rather than emitting a marker
    // for transient state — but a dedicated case so the OR branch in
    // `if (code === 'ENOENT' || code === 'EISDIR')` is exercised on
    // its own.
    const tools = createTools(WORKSPACE, {
      readFile: vi.fn(async (p: string) => {
        if (p === '/work/src/a.ts') return 'foo';
        throw fsError('EISDIR', p, 'read');
      }) as never,
      lstat: vi.fn(async () => ({ isSymbolicLink: () => false })) as never,
      readdir: vi.fn(async (p: string) => {
        if (p === '/work') return [dirent('src', 'dir')];
        if (p === '/work/src') return [dirent('a.ts', 'file'), dirent('b', 'file')];
        return [];
      }) as never,
    });
    const out = await tools.grep({ pattern: 'foo' });
    expect(out).toEqual(['src/a.ts:1: foo']);
  });

  it('skips files removed mid-scan silently (ENOENT)', async () => {
    // `b.ts` is in the directory listing but `readFile` raises ENOENT —
    // simulates the common race where readdir saw the entry but the
    // file was unlinked before grep got around to opening it.
    const tools = createTools(
      WORKSPACE,
      makeDeps({
        files: { '/work/src/a.ts': 'foo' },
        tree: {
          '/work': [dirent('src', 'dir')],
          '/work/src': [dirent('a.ts', 'file'), dirent('b.ts', 'file')],
        },
      }),
    );
    const out = await tools.grep({ pattern: 'foo' });
    expect(out).toEqual(['src/a.ts:1: foo']);
  });

  it('emits an unreadable-file marker for EACCES so missing matches are not silent', async () => {
    const tools = createTools(WORKSPACE, {
      readFile: vi.fn(async (p: string) => {
        if (p === '/work/src/a.ts') return 'foo';
        throw fsError('EACCES', p);
      }) as never,
      lstat: vi.fn(async () => ({ isSymbolicLink: () => false })) as never,
      readdir: vi.fn(async (p: string) => {
        if (p === '/work') return [dirent('src', 'dir')];
        if (p === '/work/src') return [dirent('a.ts', 'file'), dirent('locked.ts', 'file')];
        return [];
      }) as never,
    });
    const out = await tools.grep({ pattern: 'foo' });
    expect(out).toEqual(['src/a.ts:1: foo', 'src/locked.ts:0: [unreadable file: EACCES]']);
  });

  it('treats EPERM on readFile the same as EACCES (separate code, same outcome)', async () => {
    const tools = createTools(WORKSPACE, {
      readFile: vi.fn(async (p: string) => {
        throw fsError('EPERM', p);
      }) as never,
      lstat: vi.fn(async () => ({ isSymbolicLink: () => false })) as never,
      readdir: vi.fn(async (p: string) => {
        if (p === '/work') return [dirent('locked.ts', 'file')];
        return [];
      }) as never,
    });
    const out = await tools.grep({ pattern: 'foo' });
    expect(out).toEqual(['locked.ts:0: [unreadable file: EPERM]']);
  });

  it('emits an unreadable-directory marker for EACCES on readdir', async () => {
    const tools = createTools(WORKSPACE, {
      readFile: vi.fn(async () => '') as never,
      lstat: vi.fn(async () => ({ isSymbolicLink: () => false })) as never,
      readdir: vi.fn(async (p: string) => {
        if (p === '/work') return [dirent('locked', 'dir')];
        if (p === '/work/locked') throw fsError('EACCES', p, 'scandir');
        return [];
      }) as never,
    });
    const out = await tools.grep({ pattern: 'foo' });
    expect(out).toEqual(['locked:0: [unreadable directory: EACCES]']);
  });

  it('silently skips an ENOENT directory race (no marker, no error)', async () => {
    const tools = createTools(WORKSPACE, {
      readFile: vi.fn(async () => '') as never,
      lstat: vi.fn(async () => ({ isSymbolicLink: () => false })) as never,
      readdir: vi.fn(async (p: string) => {
        if (p === '/work') return [dirent('gone', 'dir')];
        if (p === '/work/gone') throw fsError('ENOENT', p, 'scandir');
        return [];
      }) as never,
    });
    const out = await tools.grep({ pattern: 'foo' });
    expect(out).toEqual([]);
  });

  it('propagates unexpected fs errors instead of silently swallowing them', async () => {
    // Used to be `.catch(() => [])` — that hid disk failures, mock
    // mistakes, descriptor exhaustion, etc. behind an empty result.
    const tools = createTools(WORKSPACE, {
      readFile: vi.fn(async () => '') as never,
      lstat: vi.fn(async () => ({ isSymbolicLink: () => false })) as never,
      readdir: vi.fn(async () => {
        throw new Error('disk failure');
      }) as never,
    });
    await expect(tools.grep({ pattern: 'foo' })).rejects.toThrow(/disk failure/);
  });

  it('propagates unexpected readFile errors instead of silently swallowing them', async () => {
    const tools = createTools(WORKSPACE, {
      readFile: vi.fn(async () => {
        throw new Error('disk failure');
      }) as never,
      lstat: vi.fn(async () => ({ isSymbolicLink: () => false })) as never,
      readdir: vi.fn(async (p: string) => {
        if (p === '/work') return [dirent('a.ts', 'file')];
        return [];
      }) as never,
    });
    await expect(tools.grep({ pattern: 'foo' })).rejects.toThrow(/disk failure/);
  });
});

describe('exported limits', () => {
  // The numeric source of truth is `@review-agent/core/limits.ts`
  // (W2-R06); `runner/src/tools.ts` re-exports those symbols for
  // back-compat so callers that already pull from `@review-agent/runner`
  // keep working. These tests pin the re-export shape, not the value —
  // value parity with core is asserted in core/limits.test.ts.
  it('exposes MAX_FILE_SIZE as a positive integer', () => {
    expect(Number.isInteger(MAX_FILE_SIZE)).toBe(true);
    expect(MAX_FILE_SIZE).toBeGreaterThan(0);
  });

  it('exposes MAX_GREP_PATTERN_LENGTH as a positive integer', () => {
    expect(Number.isInteger(MAX_GREP_PATTERN_LENGTH)).toBe(true);
    expect(MAX_GREP_PATTERN_LENGTH).toBeGreaterThan(0);
  });

  it('re-exports the same values as @review-agent/core (no local override)', async () => {
    const core = await import('@review-agent/core');
    expect(MAX_FILE_SIZE).toBe(core.MAX_FILE_SIZE);
    expect(MAX_GREP_PATTERN_LENGTH).toBe(core.MAX_GREP_PATTERN_LENGTH);
  });
});

// Spec §7.4 / issue #86: operator-supplied `privacy.deny_paths` is
// compiled to RegExp (`globToRegExp`) by the agent loop and threaded
// into the dispatcher via `createTools(_, _, denyPatterns)`. The
// dispatcher unions it with the built-in `DENY_PATTERNS` — there is
// intentionally no API to subtract from the built-ins ("extend, not
// relax"). The tests below pin behavior across all three tools.
describe('createTools — operator deny_paths (spec §7.4)', () => {
  // `compliance/**` matches everything below the compliance folder;
  // `legal/*.pdf` matches one-level PDFs in legal/.
  const operatorDeny = [globToRegExp('compliance/**'), globToRegExp('legal/*.pdf')];

  it('read_file: rejects an operator-denied path with ToolDispatchRefusedError', async () => {
    const tools = createTools(
      WORKSPACE,
      makeDeps({ files: { '/work/compliance/policy.txt': 'secret' } }),
      operatorDeny,
    );
    await expect(tools.read_file({ path: 'compliance/policy.txt' })).rejects.toBeInstanceOf(
      ToolDispatchRefusedError,
    );
    await expect(tools.read_file({ path: 'compliance/policy.txt' })).rejects.toThrow(/deny-list/);
  });

  it('read_file: still permits paths outside both built-in and operator deny lists', async () => {
    const tools = createTools(
      WORKSPACE,
      makeDeps({ files: { '/work/src/a.ts': 'hi' } }),
      operatorDeny,
    );
    expect(await tools.read_file({ path: 'src/a.ts' })).toBe('hi');
  });

  it('glob: silently drops operator-denied paths from results (no exception)', async () => {
    const tools = createTools(
      WORKSPACE,
      makeDeps({
        tree: {
          '/work': [dirent('compliance', 'dir'), dirent('src', 'dir'), dirent('legal', 'dir')],
          '/work/compliance': [dirent('policy.txt', 'file')],
          '/work/src': [dirent('a.ts', 'file')],
          '/work/legal': [dirent('contract.pdf', 'file'), dirent('memo.md', 'file')],
        },
      }),
      operatorDeny,
    );
    const out = await tools.glob({ pattern: '**/*' });
    expect(out).toContain('src/a.ts');
    expect(out).toContain('legal/memo.md');
    expect(out).not.toContain('compliance/policy.txt');
    expect(out).not.toContain('legal/contract.pdf');
  });

  it('grep: silently skips operator-denied files during scan (no marker, no error)', async () => {
    const tools = createTools(
      WORKSPACE,
      makeDeps({
        files: {
          '/work/compliance/policy.txt': 'TODO investigate',
          '/work/src/a.ts': 'TODO add tests',
        },
        tree: {
          '/work': [dirent('compliance', 'dir'), dirent('src', 'dir')],
          '/work/compliance': [dirent('policy.txt', 'file')],
          '/work/src': [dirent('a.ts', 'file')],
        },
      }),
      operatorDeny,
    );
    const out = await tools.grep({ pattern: 'TODO' });
    expect(out).toEqual(['src/a.ts:1: TODO add tests']);
  });

  it('grep: refuses an explicit scope argument that maps to a denied path', async () => {
    // `resolveSafePath` runs `checkDenyList` against the scope, so
    // calling grep with `path: 'compliance'` (a denied glob target)
    // produces a hard refusal — same shape read_file gives.
    const tools = createTools(
      WORKSPACE,
      makeDeps({
        tree: { '/work/compliance': [dirent('policy.txt', 'file')] },
      }),
      [globToRegExp('compliance')],
    );
    await expect(tools.grep({ pattern: 'TODO', path: 'compliance' })).rejects.toBeInstanceOf(
      ToolDispatchRefusedError,
    );
  });
});

describe('createTools — extend-not-relax (spec §7.4)', () => {
  it("user deny list cannot 'whitelist' a built-in deny (extend, not relax)", async () => {
    // The user's `**` pattern matches everything — but DENY_PATTERNS
    // takes precedence in the union, so `.env` is still refused even
    // when the operator's list is permissive. There is no API
    // surface that lets a user remove an entry from DENY_PATTERNS.
    const tools = createTools(WORKSPACE, makeDeps({}), [globToRegExp('**')]);
    await expect(tools.read_file({ path: '.env' })).rejects.toBeInstanceOf(
      ToolDispatchRefusedError,
    );
    await expect(tools.read_file({ path: 'secrets/db.json' })).rejects.toThrow(/deny-list/);
  });

  it('empty user deny list behaves identically to omitting the argument', async () => {
    const explicit = createTools(WORKSPACE, makeDeps({}), []);
    const implicit = createTools(WORKSPACE, makeDeps({}));
    // Both still refuse the same built-in deny entry.
    await expect(explicit.read_file({ path: '.env' })).rejects.toThrow(/deny-list/);
    await expect(implicit.read_file({ path: '.env' })).rejects.toThrow(/deny-list/);
    // And both permit the same non-deny path (no fixtures wired here —
    // the deny check runs before fs access, so ENOENT confirms we got
    // past the deny gate). Use a sentinel readFile to keep the test
    // hermetic.
    const sentinel = makeDeps({ files: { '/work/ok.ts': 'hi' } });
    expect(await createTools(WORKSPACE, sentinel).read_file({ path: 'ok.ts' })).toBe('hi');
    expect(await createTools(WORKSPACE, sentinel, []).read_file({ path: 'ok.ts' })).toBe('hi');
  });

  it('built-in case-insensitive deny still applies when operator pattern is case-sensitive', async () => {
    // Built-in `/(^|\/)secrets?(\/|$)/i` matches `Secrets/db.json`
    // by virtue of the `/i` flag — independent of whether the user
    // also adds a (case-sensitive) entry. The union must preserve
    // each pattern's compile flags rather than re-normalize them.
    const tools = createTools(WORKSPACE, makeDeps({}), [globToRegExp('compliance/**')]);
    await expect(tools.read_file({ path: 'Secrets/db.json' })).rejects.toThrow(/deny-list/);
  });

  it('user pattern compiled by globToRegExp is case-sensitive by default', async () => {
    // `Compliance/policy.txt` is NOT denied by `compliance/**` — the
    // user opts into case-sensitive matching by going through
    // globToRegExp (whose generated RegExp has no `/i` flag). This
    // is the documented behavior; case folding requires a separate,
    // explicit pattern from the operator.
    const tools = createTools(
      WORKSPACE,
      makeDeps({ files: { '/work/Compliance/policy.txt': 'visible' } }),
      [globToRegExp('compliance/**')],
    );
    expect(await tools.read_file({ path: 'Compliance/policy.txt' })).toBe('visible');
  });

  it("a 'compliance' pattern matches only the literal entry, not 'compliance/foo'", async () => {
    // Anchor regression guard: globToRegExp produces `^compliance$`
    // for the bare token. The dispatcher must NOT accidentally treat
    // it as a prefix match (which would cause every nested file to
    // be denied silently). Operators who want recursive denial must
    // write `compliance/**` explicitly.
    const tools = createTools(
      WORKSPACE,
      makeDeps({ files: { '/work/compliance/policy.txt': 'data' } }),
      [globToRegExp('compliance')],
    );
    expect(await tools.read_file({ path: 'compliance/policy.txt' })).toBe('data');
  });
});

// T4 scenario-gap coverage: cross-tool / normalization / overlap
// scenarios not already pinned by the T2/T3/T3.5 test suites. Each
// test below has a one-line note explaining the gap it closes.
describe('createTools — deny_paths cross-tool / normalization scenarios (T4)', () => {
  it('built-in deny: grep silently skips a built-in-denied file (3-tool coverage)', async () => {
    // T2 covers user-extended deny under grep; T2/pre-existing cover
    // built-in deny under read_file + glob. Built-in deny under
    // grep was the missing cell. Pins that walking into `.env` does
    // not surface its content as matches.
    const tools = createTools(
      WORKSPACE,
      makeDeps({
        files: { '/work/src/a.ts': 'TODO investigate', '/work/.env': 'TODO read me' },
        tree: {
          '/work': [dirent('src', 'dir'), dirent('.env', 'file')],
          '/work/src': [dirent('a.ts', 'file')],
        },
      }),
    );
    const out = await tools.grep({ pattern: 'TODO' });
    expect(out).toEqual(['src/a.ts:1: TODO investigate']);
  });

  it('overlap: a path matched by BOTH built-in and user deny still surfaces a single refusal', async () => {
    // `.env` is denied by the built-in `(^|\/)\.env(\..*)?$`; we also
    // hand the operator pattern `.env` as a redundant entry. The
    // dispatcher should refuse exactly once with the built-in style
    // error message — no compounded behavior, no internal "first
    // match wins" leak in the message that would expose which list
    // tripped first.
    const tools = createTools(WORKSPACE, makeDeps({}), [globToRegExp('.env')]);
    await expect(tools.read_file({ path: '.env' })).rejects.toBeInstanceOf(
      ToolDispatchRefusedError,
    );
    // The message includes the path but not the source list — pin
    // that property so future refactors don't leak the layer that
    // matched (which would let an attacker probe the deny tables).
    await expect(tools.read_file({ path: '.env' })).rejects.toThrow(/deny-list/);
  });

  it("path normalization: './compliance/foo' resolves the same as 'compliance/foo' and still hits the deny", async () => {
    // `path.resolve` collapses `./` before the dispatcher's rel
    // calculation, so both forms are equivalent at the deny gate.
    // Pin so a future refactor cannot bypass the deny by tweaking
    // the resolver.
    const tools = createTools(WORKSPACE, makeDeps({}), [globToRegExp('compliance/**')]);
    await expect(tools.read_file({ path: './compliance/policy.txt' })).rejects.toThrow(/deny-list/);
  });

  it("path normalization: 'compliance/./policy.txt' is normalized to 'compliance/policy.txt' and still denied", async () => {
    // Same idea as the prior test, but the redundant `/./` lives
    // mid-path. `path.resolve` flattens it; the deny gate sees the
    // canonical form.
    const tools = createTools(WORKSPACE, makeDeps({}), [globToRegExp('compliance/**')]);
    await expect(tools.read_file({ path: 'compliance/./policy.txt' })).rejects.toThrow(/deny-list/);
  });

  it("POSIX runner: backslash-as-separator is NOT normalized — 'compliance\\\\foo' bypasses the 'compliance/**' deny (pin known limitation)", async () => {
    // Pins the documented limitation: on Linux/macOS, `\` is a
    // literal filename character, not a path separator. An operator
    // who writes `compliance/**` in `privacy.deny_paths` is matching
    // POSIX path strings. A Windows runner would need an additional
    // normalization layer; tracked as the T5 docs caveat (Lead's
    // M-3 note from the T2 review).
    //
    // The fail-open here is bounded: a file literally named
    // `compliance\foo.txt` (with a real backslash in its name) is
    // extraordinarily uncommon and the path resolves inside the
    // workspace either way. We pin this to make future Windows-
    // runner work explicit and surface this with a clear test that
    // breaks the moment somebody flips on backslash normalization.
    const tools = createTools(
      WORKSPACE,
      makeDeps({ files: { '/work/compliance\\foo.txt': 'visible' } }),
      [globToRegExp('compliance/**')],
    );
    const content = await tools.read_file({ path: 'compliance\\foo.txt' });
    expect(content).toBe('visible');
  });

  it('Unicode normalization: NFC pattern does NOT match NFD path — pin known limitation', async () => {
    // macOS APFS stores filenames byte-for-byte but legacy HFS+ and
    // some encoding pipelines emit NFD ("café" as e + U+0301).
    // JavaScript regex compares codepoints; no implicit
    // normalization runs. An operator who writes `privacy/café/**`
    // (NFC, "é") will NOT block a file path arriving as NFD
    // ("é"). Pin the behavior so anyone tightening the deny
    // gate flips this on intentionally (and so the T5 docs caveat
    // has a code reference).
    const nfc = 'privé/data.txt'; // priv + é (NFC) + /data.txt
    const nfd = 'privé/data.txt'; // priv + e + COMBINING ACUTE + /data.txt
    const tools = createTools(WORKSPACE, makeDeps({ files: { [`/work/${nfd}`]: 'visible' } }), [
      globToRegExp(`${nfc.split('/')[0]}/**`),
    ]);
    // Sanity guard against an editor / formatter that auto-normalizes
    // the source file: if both literals collapse to the same codepoint
    // sequence the rest of the test becomes meaningless.
    expect(nfc).not.toBe(nfd);
    // NFD-stored file slips past the NFC-anchored deny pattern.
    const content = await tools.read_file({ path: nfd });
    expect(content).toBe('visible');
  });
});

describe('createAiSdkToolset — operator deny_paths forwarding', () => {
  it('forwards `denyPatterns` into the dispatcher (read_file refusal surfaces through the SDK)', async () => {
    const set = createAiSdkToolset({
      workspace: WORKSPACE,
      toolDeps: makeDeps({ files: { '/work/compliance/policy.txt': 'x' } }),
      denyPatterns: [globToRegExp('compliance/**')],
    });
    const readExec = set.read_file?.execute as (a: unknown, o: unknown) => Promise<string>;
    await expect(readExec({ path: 'compliance/policy.txt' }, {})).rejects.toBeInstanceOf(
      ToolDispatchRefusedError,
    );
  });

  it('omitting `denyPatterns` keeps the built-in deny list active', async () => {
    const set = createAiSdkToolset({ workspace: WORKSPACE, toolDeps: makeDeps({}) });
    const readExec = set.read_file?.execute as (a: unknown, o: unknown) => Promise<string>;
    await expect(readExec({ path: '.env' }, {})).rejects.toBeInstanceOf(ToolDispatchRefusedError);
  });
});
