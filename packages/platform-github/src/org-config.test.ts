import { Buffer } from 'node:buffer';
import type { Octokit } from '@octokit/rest';
import { describe, expect, it, vi } from 'vitest';
import { createGithubOrgConfigFetch } from './org-config.js';

function fakeOctokit(getContent: (args: unknown) => unknown): Pick<Octokit, 'rest'> {
  return {
    rest: { repos: { getContent: vi.fn(getContent) } },
  } as unknown as Pick<Octokit, 'rest'>;
}

describe('createGithubOrgConfigFetch', () => {
  it('returns the decoded UTF-8 content of <owner>/.github/review-agent.yml', async () => {
    const yaml = 'language: ja-JP\n';
    const octokit = fakeOctokit((args) => {
      expect(args).toMatchObject({ owner: 'acme', repo: '.github', path: 'review-agent.yml' });
      return {
        data: {
          type: 'file',
          encoding: 'base64',
          content: Buffer.from(yaml, 'utf8').toString('base64'),
        },
      };
    });
    const fetch = createGithubOrgConfigFetch({ octokit });
    expect(await fetch('acme')).toBe(yaml);
  });

  it('returns null when the file does not exist (404)', async () => {
    const octokit = fakeOctokit(() => {
      throw Object.assign(new Error('Not Found'), { status: 404 });
    });
    const fetch = createGithubOrgConfigFetch({ octokit });
    expect(await fetch('acme')).toBeNull();
  });

  it('returns null when the path resolves to a directory', async () => {
    const octokit = fakeOctokit(() => ({ data: [{ type: 'dir', name: 'review-agent.yml' }] }));
    const fetch = createGithubOrgConfigFetch({ octokit });
    expect(await fetch('acme')).toBeNull();
  });

  it('returns null when the path is a symlink', async () => {
    const octokit = fakeOctokit(() => ({ data: { type: 'symlink' } }));
    const fetch = createGithubOrgConfigFetch({ octokit });
    expect(await fetch('acme')).toBeNull();
  });

  it('throws on non-base64 encoding (defence-in-depth)', async () => {
    const octokit = fakeOctokit(() => ({
      data: { type: 'file', encoding: 'utf-8', content: 'oops' },
    }));
    const fetch = createGithubOrgConfigFetch({ octokit });
    await expect(() => fetch('acme')).rejects.toThrow(/encoding/);
  });

  it('rethrows non-404 errors', async () => {
    const octokit = fakeOctokit(() => {
      throw Object.assign(new Error('Boom'), { status: 500 });
    });
    const fetch = createGithubOrgConfigFetch({ octokit });
    await expect(() => fetch('acme')).rejects.toThrow('Boom');
  });

  it('honours custom repoName / filePath overrides', async () => {
    const octokit = fakeOctokit((args) => {
      expect(args).toMatchObject({
        owner: 'acme',
        repo: 'org-shared',
        path: 'review-agent/config.yml',
      });
      return {
        data: {
          type: 'file',
          encoding: 'base64',
          content: Buffer.from('language: en-US\n').toString('base64'),
        },
      };
    });
    const fetch = createGithubOrgConfigFetch({
      octokit,
      repoName: 'org-shared',
      filePath: 'review-agent/config.yml',
    });
    expect(await fetch('acme')).toContain('en-US');
  });
});
