import { describe, expect, it } from 'vitest';
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

  it('rejects unknown triggeredBy', () => {
    expect(() =>
      JobMessageSchema.parse({
        jobId: 'j',
        installationId: 'i',
        prRef: { platform: 'github', owner: 'o', repo: 'r', number: 1 },
        triggeredBy: 'random',
        enqueuedAt: '2026-04-30T00:00:00.000Z',
      }),
    ).toThrow();
  });

  it('rejects non-positive PR number', () => {
    expect(() =>
      JobMessageSchema.parse({
        jobId: 'j',
        installationId: 'i',
        prRef: { platform: 'github', owner: 'o', repo: 'r', number: 0 },
        triggeredBy: 'manual',
        enqueuedAt: '2026-04-30T00:00:00.000Z',
      }),
    ).toThrow();
  });
});
