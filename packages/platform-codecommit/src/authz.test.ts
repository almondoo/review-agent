import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkCodeCommitFeedbackAuthz } from './authz.js';

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
    expect(r).toEqual({ allowed: true });
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

  it('denies an empty-string principalId even if the allowlist accidentally contains an empty entry', () => {
    // parseAllowlist strips empty entries, so this exercises the
    // defensive principalId.length === 0 check at the function head —
    // belt-and-suspenders against a stub/CLI that could call us with
    // principalId = '' (e.g. CodeCommit comment with no authorArn).
    const r = checkCodeCommitFeedbackAuthz({
      principalId: '',
      allowlistEnv: ',AIDABOB,', // intentional leading/trailing empties
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
