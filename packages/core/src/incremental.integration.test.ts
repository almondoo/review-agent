// Real `git init` integration test for computeDiffStrategy. Uses a /tmp
// repo so it runs offline. Skipped if `git` is not on PATH.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { computeDiffStrategy } from './incremental.js';
import type { ReviewState } from './review.js';

function gitAvailable(): boolean {
  const out = spawnSync('git', ['--version']);
  return out.status === 0;
}

function git(workspace: string, args: ReadonlyArray<string>): string {
  return execFileSync('git', ['-C', workspace, ...args], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@example.com',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@example.com',
    },
  })
    .toString()
    .trim();
}

function commit(workspace: string, file: string, content: string, msg: string): string {
  execFileSync(
    'node',
    ['-e', `require('node:fs').writeFileSync(${JSON.stringify(file)}, ${JSON.stringify(content)})`],
    {
      cwd: workspace,
    },
  );
  git(workspace, ['add', file]);
  git(workspace, ['commit', '-m', msg]);
  return git(workspace, ['rev-parse', 'HEAD']);
}

function makeState(base: string, head: string): ReviewState {
  return {
    schemaVersion: 1,
    lastReviewedSha: head,
    baseSha: base,
    reviewedAt: '2026-04-30T00:00:00Z',
    modelUsed: 'm',
    totalTokens: 0,
    totalCostUsd: 0,
    commentFingerprints: [],
  };
}

describe.skipIf(!gitAvailable())('computeDiffStrategy (real git)', () => {
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'review-agent-incremental-'));
    git(workspace, ['init', '-q', '-b', 'main']);
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it('returns incremental when prev head is reachable', async () => {
    const a = commit(workspace, 'a.txt', '1\n', 'a');
    const b = commit(workspace, 'a.txt', '1\n2\n', 'b');
    const c = commit(workspace, 'a.txt', '1\n2\n3\n', 'c');
    const r = await computeDiffStrategy(workspace, makeState(a, b), {
      baseSha: a,
      headSha: c,
    });
    expect(r).toEqual({ since: b });
  });

  it('returns full when previous head is no longer reachable (force-push)', async () => {
    const a = commit(workspace, 'a.txt', '1\n', 'a');
    const b = commit(workspace, 'a.txt', '1\n2\n', 'b');
    git(workspace, ['reset', '--hard', a]);
    const c = commit(workspace, 'a.txt', '1\nx\n', 'c-divergent');
    const r = await computeDiffStrategy(workspace, makeState(a, b), {
      baseSha: a,
      headSha: c,
    });
    expect(r).toBe('full');
  });
});
