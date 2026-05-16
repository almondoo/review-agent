import { Buffer } from 'node:buffer';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { CloneOpts, Diff, PRRef, VCS } from '@review-agent/core';
import { describe, expect, it, vi } from 'vitest';
import { provisionWorkspace } from './workspace.js';

const ref: PRRef = { platform: 'github', owner: 'o', repo: 'r', number: 1 };

function makeDiff(files: ReadonlyArray<Partial<Diff['files'][number]>>): Diff {
  return {
    baseSha: 'B',
    headSha: 'H',
    files: files.map((f) => ({
      path: f.path ?? 'src/x.ts',
      previousPath: f.previousPath ?? null,
      status: f.status ?? 'modified',
      additions: f.additions ?? 1,
      deletions: f.deletions ?? 0,
      patch: f.patch ?? '@@',
    })),
  };
}

function makeVcs(overrides: Partial<VCS> = {}): VCS {
  return {
    platform: 'github',
    getPR: vi.fn(),
    getDiff: vi.fn(),
    getFile: vi.fn(),
    cloneRepo: vi.fn(),
    postReview: vi.fn(),
    postSummary: vi.fn(),
    getExistingComments: vi.fn(),
    getStateComment: vi.fn(),
    upsertStateComment: vi.fn(),
    ...overrides,
  };
}

describe('provisionWorkspace — strategy: none', () => {
  it('returns an empty dir + no-op cleanup; no fs / vcs side-effects', async () => {
    const vcs = makeVcs();
    const mkdtemp = vi.fn();
    const handle = await provisionWorkspace(
      { strategy: 'none', vcs, ref, headSha: 'H', diff: makeDiff([{ path: 'a.ts' }]) },
      { mkdtemp },
    );
    expect(handle.dir).toBe('');
    expect(mkdtemp).not.toHaveBeenCalled();
    expect(vcs.getFile).not.toHaveBeenCalled();
    expect(vcs.cloneRepo).not.toHaveBeenCalled();
    // cleanup is a no-op; calling twice does not throw.
    await handle.cleanup();
    await handle.cleanup();
  });
});

describe('provisionWorkspace — strategy: contents-api', () => {
  it('writes one file per non-removed diff entry under the workspace dir', async () => {
    const getFile = vi.fn(async (_ref: PRRef, path: string) => Buffer.from(`content of ${path}`));
    const vcs = makeVcs({ getFile });
    const written: Array<{ path: string; data: unknown }> = [];
    const mkdirs: string[] = [];
    const handle = await provisionWorkspace(
      {
        strategy: 'contents-api',
        vcs,
        ref,
        headSha: 'H',
        diff: makeDiff([
          { path: 'src/a.ts' },
          { path: 'src/b.ts' },
          // removed entries are skipped; no fetch.
          { path: 'src/c.ts', status: 'removed' },
        ]),
      },
      {
        tmpdir: () => '/tmp-fake',
        mkdtemp: vi.fn(async (prefix) => `${prefix}123`),
        mkdir: vi.fn(async (p) => {
          mkdirs.push(p as string);
          return undefined;
        }) as never,
        writeFile: vi.fn(async (p, data) => {
          written.push({ path: p as string, data });
        }) as never,
        rm: vi.fn(async () => undefined),
      },
    );
    expect(handle.dir).toMatch(/review-agent-ws-/);
    expect(getFile).toHaveBeenCalledTimes(2);
    expect(written).toHaveLength(2);
    expect(written.map((w) => w.path).sort()).toEqual([
      `${handle.dir}/src/a.ts`,
      `${handle.dir}/src/b.ts`,
    ]);
    expect((written[0]?.data as Buffer).toString()).toContain('content of src/');
  });

  it('refuses denylisted paths (.env, secrets/, *.pem) even when present in the diff', async () => {
    const getFile = vi.fn(async () => Buffer.from('secret'));
    const vcs = makeVcs({ getFile });
    const handle = await provisionWorkspace(
      {
        strategy: 'contents-api',
        vcs,
        ref,
        headSha: 'H',
        diff: makeDiff([
          { path: '.env' },
          { path: '.env.production' },
          { path: 'secrets/db.json' },
          { path: 'config/private/key.json' },
          { path: 'tls/server.pem' },
          { path: 'credentials.json' },
          { path: 'service-account.json' },
          // Reviewer I-1 on #63: this entry was missing from the
          // workspace provisioner's deny-list while present in
          // runner/src/tools.ts, leaving a bytes-on-disk window
          // for `.aws/credentials` in the worker tmpdir.
          { path: '.aws/credentials' },
          { path: 'src/ok.ts' }, // only this one should fetch.
        ]),
      },
      {
        tmpdir: () => '/tmp-fake',
        mkdtemp: vi.fn(async (prefix) => `${prefix}123`),
        mkdir: vi.fn(async () => undefined) as never,
        writeFile: vi.fn(async () => undefined) as never,
        rm: vi.fn(async () => undefined),
      },
    );
    // Only src/ok.ts (the one allowed file) should have been fetched.
    expect(getFile).toHaveBeenCalledTimes(1);
    expect(getFile.mock.calls[0]?.[1]).toBe('src/ok.ts');
    // cleanup is wired and idempotent.
    await handle.cleanup();
  });

  it('cleans up the workspace and re-throws when the fetch step fails', async () => {
    const getFile = vi.fn(async () => {
      throw new Error('contents API 500');
    });
    const vcs = makeVcs({ getFile });
    const rm = vi.fn(async () => undefined);
    await expect(
      provisionWorkspace(
        {
          strategy: 'contents-api',
          vcs,
          ref,
          headSha: 'H',
          diff: makeDiff([{ path: 'src/a.ts' }]),
        },
        {
          tmpdir: () => '/tmp-fake',
          mkdtemp: vi.fn(async (prefix) => `${prefix}xyz`),
          mkdir: vi.fn(async () => undefined) as never,
          writeFile: vi.fn(async () => undefined) as never,
          rm,
        },
      ),
    ).rejects.toThrow(/contents API 500/);
    // The created tmpdir must have been removed on failure.
    expect(rm).toHaveBeenCalledTimes(1);
    expect(rm.mock.calls[0]?.[0]).toMatch(/review-agent-ws-/);
  });

  it('cleanup is idempotent — calling twice removes once', async () => {
    const vcs = makeVcs({ getFile: vi.fn(async () => Buffer.from('x')) });
    const rm = vi.fn(async () => undefined);
    const handle = await provisionWorkspace(
      { strategy: 'contents-api', vcs, ref, headSha: 'H', diff: makeDiff([]) },
      {
        tmpdir: () => '/tmp-fake',
        mkdtemp: vi.fn(async (prefix) => `${prefix}123`),
        mkdir: vi.fn(async () => undefined) as never,
        writeFile: vi.fn(async () => undefined) as never,
        rm,
      },
    );
    await handle.cleanup();
    await handle.cleanup();
    expect(rm).toHaveBeenCalledTimes(1);
  });
});

describe('provisionWorkspace — strategy: sparse-clone', () => {
  it('delegates to vcs.cloneRepo with depth=1, filter=blob:none, and sparse parent dirs', async () => {
    const cloneRepo = vi.fn<VCS['cloneRepo']>(async () => undefined);
    const vcs = makeVcs({ cloneRepo });
    const handle = await provisionWorkspace(
      {
        strategy: 'sparse-clone',
        vcs,
        ref,
        headSha: 'H',
        diff: makeDiff([{ path: 'src/a.ts' }, { path: 'src/b.ts' }, { path: 'docs/README.md' }]),
      },
      {
        tmpdir: () => '/tmp-fake',
        mkdtemp: vi.fn(async (prefix) => `${prefix}clone`),
        mkdir: vi.fn(async () => undefined) as never,
        writeFile: vi.fn(async () => undefined) as never,
        rm: vi.fn(async () => undefined),
      },
    );
    expect(cloneRepo).toHaveBeenCalledTimes(1);
    const args = cloneRepo.mock.calls[0];
    expect(args?.[0]).toEqual(ref);
    expect(args?.[1]).toMatch(/review-agent-ws-/);
    const opts = args?.[2] as CloneOpts;
    expect(opts.depth).toBe(1);
    expect(opts.filter).toBe('blob:none');
    // Sparse paths reduced to unique parent dirs.
    expect([...(opts.sparsePaths ?? [])].sort()).toEqual(['docs', 'src']);
    await handle.cleanup();
  });

  it('drops denylisted paths from the sparse-checkout pattern set', async () => {
    const cloneRepo = vi.fn<VCS['cloneRepo']>(async () => undefined);
    const vcs = makeVcs({ cloneRepo });
    await provisionWorkspace(
      {
        strategy: 'sparse-clone',
        vcs,
        ref,
        headSha: 'H',
        diff: makeDiff([{ path: '.env' }, { path: 'src/a.ts' }, { path: 'secrets/db.json' }]),
      },
      {
        tmpdir: () => '/tmp-fake',
        mkdtemp: vi.fn(async (prefix) => `${prefix}clone`),
        mkdir: vi.fn(async () => undefined) as never,
        writeFile: vi.fn(async () => undefined) as never,
        rm: vi.fn(async () => undefined),
      },
    );
    const opts = cloneRepo.mock.calls[0]?.[2] as CloneOpts;
    expect(opts.sparsePaths).toEqual(['src']);
  });

  it('contents-api: real-fs integration — fetched files are read-back-able via fs at workspace.dir + relative path', async () => {
    // Acceptance criterion: with workspace_strategy='contents-api',
    // a Server-mode review can `read_file` a changed file referenced
    // by the diff. We don't import the runner's createTools here
    // (would cross-package the test), but we hit the same on-disk
    // contract: the file under handle.dir/<path> must be present and
    // contain the bytes the VCS returned.
    const fixtures: Record<string, string> = {
      'src/caller.ts': 'import { helper } from "./helper";\nhelper();\n',
      'src/helper.ts': 'export function helper() { return 42; }\n',
    };
    const getFile = vi.fn(async (_ref: PRRef, path: string) => Buffer.from(fixtures[path] ?? ''));
    const vcs = makeVcs({ getFile });
    const handle = await provisionWorkspace({
      strategy: 'contents-api',
      vcs,
      ref,
      headSha: 'H',
      diff: makeDiff([{ path: 'src/caller.ts' }, { path: 'src/helper.ts' }]),
    });
    try {
      // Both files materialized on the real filesystem.
      const callerStat = await stat(join(handle.dir, 'src/caller.ts'));
      const helperStat = await stat(join(handle.dir, 'src/helper.ts'));
      expect(callerStat.isFile()).toBe(true);
      expect(helperStat.isFile()).toBe(true);
      // Content round-trips byte-for-byte from VCS.getFile.
      const helperContent = await readFile(join(handle.dir, 'src/helper.ts'), 'utf8');
      expect(helperContent).toBe(fixtures['src/helper.ts']);
    } finally {
      await handle.cleanup();
    }
    // After cleanup the workspace dir is gone — read should fail.
    await expect(readFile(join(handle.dir, 'src/helper.ts'), 'utf8')).rejects.toThrow();
  });

  it('cleans up and re-throws when cloneRepo fails', async () => {
    const cloneRepo = vi.fn<VCS['cloneRepo']>(async () => {
      throw new Error('git clone failed');
    });
    const vcs = makeVcs({ cloneRepo });
    const rm = vi.fn(async () => undefined);
    await expect(
      provisionWorkspace(
        { strategy: 'sparse-clone', vcs, ref, headSha: 'H', diff: makeDiff([{ path: 'a.ts' }]) },
        {
          tmpdir: () => '/tmp-fake',
          mkdtemp: vi.fn(async (prefix) => `${prefix}clone`),
          mkdir: vi.fn(async () => undefined) as never,
          writeFile: vi.fn(async () => undefined) as never,
          rm,
        },
      ),
    ).rejects.toThrow(/git clone failed/);
    expect(rm).toHaveBeenCalledTimes(1);
  });
});
