import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { JobMessageSchema } from './queue.js';

describe('JobMessageSchema', () => {
  it('accepts a minimal valid message', () => {
    const m = JobMessageSchema.parse({
      jobId: 'o/r#1@123',
      installationId: '42',
      prRef: { platform: 'github', owner: 'o', repo: 'r', number: 1 },
      triggeredBy: 'pull_request.opened',
      enqueuedAt: '2026-04-30T00:00:00.000Z',
    });
    expect(m.prRef.headSha).toBeUndefined();
  });

  it('preserves headSha when supplied', () => {
    const m = JobMessageSchema.parse({
      jobId: 'j',
      installationId: 'i',
      prRef: { platform: 'github', owner: 'o', repo: 'r', number: 2, headSha: 'abc1234' },
      triggeredBy: 'comment.command',
      enqueuedAt: '2026-04-30T00:00:00.000Z',
    });
    expect(m.prRef.headSha).toBe('abc1234');
  });

  it('rejects unknown triggeredBy with ZodError', () => {
    expect(() =>
      JobMessageSchema.parse({
        jobId: 'j',
        installationId: 'i',
        prRef: { platform: 'github', owner: 'o', repo: 'r', number: 1 },
        triggeredBy: 'random',
        enqueuedAt: '2026-04-30T00:00:00.000Z',
      }),
    ).toThrow(z.ZodError);
  });

  it('rejects non-positive PR number with ZodError', () => {
    expect(() =>
      JobMessageSchema.parse({
        jobId: 'j',
        installationId: 'i',
        prRef: { platform: 'github', owner: 'o', repo: 'r', number: 0 },
        triggeredBy: 'manual',
        enqueuedAt: '2026-04-30T00:00:00.000Z',
      }),
    ).toThrow(z.ZodError);
  });

  // Boundary cases for length-constrained string fields. The schema documents
  // headSha 7..64, jobId 1..128, installationId 1..64. These tests pin those
  // limits so a downstream tightening (e.g. min(8)) is caught immediately.
  function buildBase() {
    return {
      jobId: 'j',
      installationId: 'i',
      prRef: { platform: 'github' as const, owner: 'o', repo: 'r', number: 1 },
      triggeredBy: 'manual' as const,
      enqueuedAt: '2026-04-30T00:00:00.000Z',
    };
  }

  it('rejects headSha shorter than 7 chars', () => {
    expect(() =>
      JobMessageSchema.parse({
        ...buildBase(),
        prRef: { ...buildBase().prRef, headSha: 'abc123' },
      }),
    ).toThrow(z.ZodError);
  });

  it('accepts headSha at the 7-char minimum', () => {
    const m = JobMessageSchema.parse({
      ...buildBase(),
      prRef: { ...buildBase().prRef, headSha: 'abc1234' },
    });
    expect(m.prRef.headSha).toBe('abc1234');
  });

  it('accepts headSha at the 64-char maximum', () => {
    const sha = 'a'.repeat(64);
    const m = JobMessageSchema.parse({
      ...buildBase(),
      prRef: { ...buildBase().prRef, headSha: sha },
    });
    expect(m.prRef.headSha).toBe(sha);
  });

  it('rejects headSha longer than 64 chars', () => {
    expect(() =>
      JobMessageSchema.parse({
        ...buildBase(),
        prRef: { ...buildBase().prRef, headSha: 'a'.repeat(65) },
      }),
    ).toThrow(z.ZodError);
  });

  it('rejects empty jobId', () => {
    expect(() => JobMessageSchema.parse({ ...buildBase(), jobId: '' })).toThrow(z.ZodError);
  });

  it('rejects jobId longer than 128 chars', () => {
    expect(() => JobMessageSchema.parse({ ...buildBase(), jobId: 'a'.repeat(129) })).toThrow(
      z.ZodError,
    );
  });

  it('rejects installationId longer than 64 chars', () => {
    expect(() =>
      JobMessageSchema.parse({ ...buildBase(), installationId: 'a'.repeat(65) }),
    ).toThrow(z.ZodError);
  });

  it("accepts prRef.platform 'codecommit' with empty owner", () => {
    const m = JobMessageSchema.parse({
      jobId: 'codecommit:my-repo#7@1700000000000',
      installationId: 'sns-msg-id',
      prRef: { platform: 'codecommit', owner: '', repo: 'my-repo', number: 7 },
      triggeredBy: 'pull_request.opened',
      enqueuedAt: '2026-04-30T00:00:00.000Z',
    });
    expect(m.prRef.platform).toBe('codecommit');
    expect(m.prRef.repo).toBe('my-repo');
  });

  it('rejects prRef.platform outside the enum', () => {
    expect(() =>
      JobMessageSchema.parse({
        ...buildBase(),
        prRef: { ...buildBase().prRef, platform: 'gitlab' },
      }),
    ).toThrow(z.ZodError);
  });

  // SEC-4: per-platform owner constraint asymmetry. The discriminated union
  // enforces that GitHub refs MUST carry a non-empty owner (otherwise the
  // clone URL `https://x-access-token:${token}@github.com//${repo}.git`
  // becomes a token-leak vector) and CodeCommit refs MUST carry an empty
  // owner (the AWS account ID lives on the installation row, not the ref —
  // so a non-empty `owner` would risk stateId namespace collisions with a
  // real GitHub `<owner>/<repo>#N`).
  it('rejects prRef with platform=github and empty owner', () => {
    expect(() =>
      JobMessageSchema.parse({
        jobId: 'j',
        installationId: 'i',
        prRef: { platform: 'github', owner: '', repo: 'r', number: 1 },
        triggeredBy: 'manual',
        enqueuedAt: '2026-04-30T00:00:00.000Z',
      }),
    ).toThrow(z.ZodError);
  });

  it('rejects prRef with platform=codecommit and non-empty owner', () => {
    expect(() =>
      JobMessageSchema.parse({
        jobId: 'j',
        installationId: 'i',
        prRef: { platform: 'codecommit', owner: 'something', repo: 'r', number: 1 },
        triggeredBy: 'manual',
        enqueuedAt: '2026-04-30T00:00:00.000Z',
      }),
    ).toThrow(z.ZodError);
  });
});
