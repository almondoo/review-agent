import type { PRRef } from '@review-agent/core';
import { describe, expect, it, vi } from 'vitest';
import { cloneWithStrategy, type RunGit } from './clone.js';

const ref: PRRef = { platform: 'github', owner: 'o', repo: 'r', number: 1 };
const headSha = 'abc1234567890';

function recordingRunGit(): { runGit: RunGit; calls: string[][] } {
  const calls: string[][] = [];
  const runGit: RunGit = vi.fn(async (args) => {
    calls.push([...args]);
  });
  return { runGit, calls };
}

describe('cloneWithStrategy', () => {
  it('clones with default depth 50, blob:none filter, no checkout, no tags', async () => {
    const { runGit, calls } = recordingRunGit();
    await cloneWithStrategy(
      'https://example/x.git',
      '/tmp/a',
      ref,
      headSha,
      { filter: 'blob:none' },
      runGit,
    );
    expect(calls[0]).toEqual([
      'clone',
      '--depth=50',
      '--no-checkout',
      '--no-tags',
      '--filter=blob:none',
      '--',
      'https://example/x.git',
      '/tmp/a',
    ]);
  });

  it('honors custom depth', async () => {
    const { runGit, calls } = recordingRunGit();
    await cloneWithStrategy(
      'https://example/x.git',
      '/tmp/a',
      ref,
      headSha,
      { depth: 100 },
      runGit,
    );
    expect(calls[0]).toContain('--depth=100');
  });

  it('omits filter flag when filter=none', async () => {
    const { runGit, calls } = recordingRunGit();
    await cloneWithStrategy(
      'https://example/x.git',
      '/tmp/a',
      ref,
      headSha,
      { filter: 'none' },
      runGit,
    );
    expect(calls[0]?.some((a) => a.startsWith('--filter='))).toBe(false);
  });

  it('initializes sparse-checkout when sparsePaths is provided', async () => {
    const { runGit, calls } = recordingRunGit();
    await cloneWithStrategy(
      'https://example/x.git',
      '/tmp/a',
      ref,
      headSha,
      { sparsePaths: ['src', 'packages/core'] },
      runGit,
    );
    const sparse = calls.filter((c) => c.includes('sparse-checkout'));
    expect(sparse).toHaveLength(2);
    expect(sparse[1]).toEqual(['-C', '/tmp/a', 'sparse-checkout', 'set', 'src', 'packages/core']);
  });

  it('skips sparse-checkout when sparsePaths is empty', async () => {
    const { runGit, calls } = recordingRunGit();
    await cloneWithStrategy(
      'https://example/x.git',
      '/tmp/a',
      ref,
      headSha,
      { sparsePaths: [] },
      runGit,
    );
    expect(calls.some((c) => c.includes('sparse-checkout'))).toBe(false);
  });

  it('skips sparse-checkout when sparsePaths exceeds 100 entries (per §9.2)', async () => {
    const { runGit, calls } = recordingRunGit();
    const many = Array.from({ length: 101 }, (_, i) => `dir${i}`);
    await cloneWithStrategy(
      'https://example/x.git',
      '/tmp/a',
      ref,
      headSha,
      { sparsePaths: many },
      runGit,
    );
    expect(calls.some((c) => c.includes('sparse-checkout'))).toBe(false);
  });

  it('passes --recurse-submodules when submodules: true', async () => {
    const { runGit, calls } = recordingRunGit();
    await cloneWithStrategy(
      'https://example/x.git',
      '/tmp/a',
      ref,
      headSha,
      { submodules: true },
      runGit,
    );
    expect(calls[0]).toContain('--recurse-submodules');
    expect(calls[0]).toContain('--shallow-submodules');
  });

  it('refuses unsafe head sha', async () => {
    const { runGit } = recordingRunGit();
    await expect(
      cloneWithStrategy('https://example/x.git', '/tmp/a', ref, '$(rm -rf /)', {}, runGit),
    ).rejects.toThrow(/unsafe git ref/);
  });

  it('finishes with fetch + checkout for the head sha', async () => {
    const { runGit, calls } = recordingRunGit();
    await cloneWithStrategy('https://example/x.git', '/tmp/a', ref, headSha, {}, runGit);
    const last = calls[calls.length - 1];
    const second = calls[calls.length - 2];
    expect(last).toEqual(['-C', '/tmp/a', 'checkout', headSha]);
    expect(second).toEqual(['-C', '/tmp/a', 'fetch', 'origin', headSha, '--depth=50']);
  });
});
