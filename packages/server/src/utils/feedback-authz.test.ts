import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type CollaboratorPermissionGetter,
  checkCodeCommitFeedbackAuthz,
  checkGithubFeedbackAuthz,
} from './feedback-authz.js';

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

describe('checkCodeCommitFeedbackAuthz', () => {
  const ORIGINAL_ENV = process.env.REVIEW_AGENT_FEEDBACK_ALLOWLIST;

  beforeEach(() => {
    delete process.env.REVIEW_AGENT_FEEDBACK_ALLOWLIST;
  });

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) {
      delete process.env.REVIEW_AGENT_FEEDBACK_ALLOWLIST;
    } else {
      process.env.REVIEW_AGENT_FEEDBACK_ALLOWLIST = ORIGINAL_ENV;
    }
  });

  it('denies when allowlistEnv is unset (fail-closed)', () => {
    const r = checkCodeCommitFeedbackAuthz({ principalId: 'AIDAEXAMPLE' });
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/fail-closed/);
  });

  it('denies when allowlistEnv is empty string (fail-closed)', () => {
    const r = checkCodeCommitFeedbackAuthz({
      principalId: 'AIDAEXAMPLE',
      allowlistEnv: '',
    });
    expect(r.allowed).toBe(false);
  });

  it('allows when the principal is on the allowlist (single entry)', () => {
    const r = checkCodeCommitFeedbackAuthz({
      principalId: 'AIDAEXAMPLE',
      allowlistEnv: 'AIDAEXAMPLE',
    });
    expect(r).toEqual({ allowed: true });
  });

  it('allows when the principal is on the allowlist (CSV with spaces)', () => {
    const r = checkCodeCommitFeedbackAuthz({
      principalId: 'AIDABOB',
      allowlistEnv: 'AIDAALICE, AIDABOB ,AIDACAROL',
    });
    expect(r.allowed).toBe(true);
  });

  it('denies when the principal is not on the allowlist', () => {
    const r = checkCodeCommitFeedbackAuthz({
      principalId: 'AIDAEVE',
      allowlistEnv: 'AIDAALICE,AIDABOB',
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/not on/);
  });

  it('denies when the principalId is empty (defensive)', () => {
    const r = checkCodeCommitFeedbackAuthz({
      principalId: '',
      allowlistEnv: 'AIDAALICE',
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/missing principalId/);
  });

  it('reads from process.env.REVIEW_AGENT_FEEDBACK_ALLOWLIST when allowlistEnv is unset', () => {
    process.env.REVIEW_AGENT_FEEDBACK_ALLOWLIST = 'AIDAALICE,AIDABOB';
    const r = checkCodeCommitFeedbackAuthz({ principalId: 'AIDABOB' });
    expect(r.allowed).toBe(true);
  });
});
