import { describe, expect, it, vi } from 'vitest';
import { type CollaboratorPermissionGetter, checkGithubFeedbackAuthz } from './feedback-authz.js';

function makeOctokit(getter: CollaboratorPermissionGetter) {
  return {
    rest: {
      repos: { getCollaboratorPermissionLevel: getter },
    },
  };
}

describe('checkGithubFeedbackAuthz', () => {
  it('allows when permission is admin', async () => {
    const octokit = makeOctokit(async () => ({ data: { permission: 'admin' } }));
    const r = await checkGithubFeedbackAuthz({
      octokit,
      owner: 'o',
      repo: 'r',
      username: 'alice',
    });
    expect(r).toEqual({ allowed: true });
  });

  it('allows when permission is maintain', async () => {
    const octokit = makeOctokit(async () => ({ data: { permission: 'maintain' } }));
    const r = await checkGithubFeedbackAuthz({
      octokit,
      owner: 'o',
      repo: 'r',
      username: 'alice',
    });
    expect(r.allowed).toBe(true);
  });

  it('allows when permission is write', async () => {
    const octokit = makeOctokit(async () => ({ data: { permission: 'write' } }));
    const r = await checkGithubFeedbackAuthz({
      octokit,
      owner: 'o',
      repo: 'r',
      username: 'alice',
    });
    expect(r.allowed).toBe(true);
  });

  it('denies when permission is read', async () => {
    const octokit = makeOctokit(async () => ({ data: { permission: 'read' } }));
    const r = await checkGithubFeedbackAuthz({
      octokit,
      owner: 'o',
      repo: 'r',
      username: 'alice',
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/below write/);
  });

  it('denies when permission is triage', async () => {
    const octokit = makeOctokit(async () => ({ data: { permission: 'triage' } }));
    const r = await checkGithubFeedbackAuthz({
      octokit,
      owner: 'o',
      repo: 'r',
      username: 'alice',
    });
    expect(r.allowed).toBe(false);
  });

  it('denies when the response is missing the permission field', async () => {
    const octokit = makeOctokit(async () => ({ data: {} }));
    const r = await checkGithubFeedbackAuthz({
      octokit,
      owner: 'o',
      repo: 'r',
      username: 'alice',
    });
    expect(r.allowed).toBe(false);
  });

  it('denies (fail-closed) when getCollaboratorPermissionLevel throws', async () => {
    const octokit = makeOctokit(async () => {
      throw new Error('403 Resource not accessible by integration');
    });
    const r = await checkGithubFeedbackAuthz({
      octokit,
      owner: 'o',
      repo: 'r',
      username: 'alice',
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/threw/);
  });

  it('denies when username is empty (defensive)', async () => {
    const getter = vi.fn();
    const octokit = makeOctokit(getter as unknown as CollaboratorPermissionGetter);
    const r = await checkGithubFeedbackAuthz({
      octokit,
      owner: 'o',
      repo: 'r',
      username: '',
    });
    expect(r.allowed).toBe(false);
    expect(getter).not.toHaveBeenCalled();
  });
});

// `checkCodeCommitFeedbackAuthz` lives in `@review-agent/platform-codecommit`
// (v1.2 #113); its unit tests are in `packages/platform-codecommit/src/authz.test.ts`.
