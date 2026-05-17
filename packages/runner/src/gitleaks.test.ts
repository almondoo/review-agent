import { GitleaksScanError } from '@review-agent/core';
import { describe, expect, it, vi } from 'vitest';
import {
  applyRedactions,
  quickScanContent,
  type SpawnFn,
  scanWorkspaceWithGitleaks,
  shouldAbortReview,
} from './gitleaks.js';

describe('quickScanContent — well-known secret patterns', () => {
  it('matches AWS access keys', () => {
    const findings = quickScanContent('AKIAIOSFODNN7EXAMPLE');
    expect(findings).toHaveLength(1);
    expect(findings[0]?.ruleId).toBe('aws-access-key');
  });

  it('matches GitHub PATs (classic)', () => {
    const findings = quickScanContent(`token: ghp_${'x'.repeat(36)}`);
    expect(findings.some((f) => f.ruleId === 'github-pat')).toBe(true);
  });

  it('matches Anthropic keys', () => {
    const findings = quickScanContent(`key=sk-ant-${'a'.repeat(40)}`);
    expect(findings.some((f) => f.ruleId === 'anthropic-key')).toBe(true);
  });

  it('matches private key blocks', () => {
    const findings = quickScanContent('-----BEGIN RSA PRIVATE KEY-----\nABC\n');
    expect(findings.some((f) => f.ruleId === 'private-key-block')).toBe(true);
  });

  it('matches OpenAI keys', () => {
    const findings = quickScanContent(`OPENAI_API_KEY=sk-${'A'.repeat(48)}`);
    expect(findings.some((f) => f.ruleId === 'openai-key')).toBe(true);
  });

  it('flags high-entropy strings >= 4.5 bits per char', () => {
    // A random-looking 40+ char base64-like string with high entropy.
    const highEntropy = 'aB3kJ7lQzYx9PqRtVw2sNm0E4hC1uF6dGyZjI8oX';
    const findings = quickScanContent(`token=${highEntropy}`);
    expect(findings.some((f) => f.ruleId === 'high-entropy')).toBe(true);
    expect(findings.find((f) => f.ruleId === 'high-entropy')?.entropy).toBeGreaterThanOrEqual(4.5);
  });

  it('does not flag low-entropy long strings as high-entropy', () => {
    // 40+ chars of base64-allowed characters but pure repetition → low entropy.
    const lowEntropy = 'aaaa'.repeat(15);
    const findings = quickScanContent(`token=${lowEntropy}`);
    expect(findings.some((f) => f.ruleId === 'high-entropy')).toBe(false);
  });

  it('returns empty for benign text', () => {
    expect(quickScanContent('hello world\nconst x = 1;\n')).toHaveLength(0);
  });
});

describe('applyRedactions', () => {
  it('replaces every occurrence of each secret with [REDACTED:rule]', () => {
    const input = 'AKIAIOSFODNN7EXAMPLE was logged twice: AKIAIOSFODNN7EXAMPLE.';
    const findings = quickScanContent(input);
    const redacted = applyRedactions(input, findings);
    expect(redacted).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(redacted).toContain('[REDACTED:aws-access-key]');
    expect((redacted.match(/\[REDACTED:aws-access-key\]/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it('skips findings with empty secret string', () => {
    const out = applyRedactions('hello', [
      {
        ruleId: 'x',
        description: '',
        file: '',
        startLine: 0,
        endLine: 0,
        match: '',
        secret: '',
        entropy: 0,
        tags: [],
      },
    ]);
    expect(out).toBe('hello');
  });
});

describe('shouldAbortReview', () => {
  it('aborts on any high-confidence finding', () => {
    const decision = shouldAbortReview([
      {
        ruleId: 'aws-access-key',
        description: '',
        file: '',
        startLine: 0,
        endLine: 0,
        match: '',
        secret: '',
        entropy: 0,
        tags: ['high'],
      },
    ]);
    expect(decision.abort).toBe(true);
    expect(decision.reason).toContain('aws-access-key');
  });

  it('aborts when more than 3 findings overall', () => {
    const four = Array.from({ length: 4 }, () => ({
      ruleId: 'medium',
      description: '',
      file: '',
      startLine: 0,
      endLine: 0,
      match: '',
      secret: '',
      entropy: 0,
      tags: ['medium'] as ReadonlyArray<string>,
    }));
    expect(shouldAbortReview(four).abort).toBe(true);
  });

  it('does not abort on 0–3 medium findings (boundary at exactly 3)', () => {
    const mk = (count: number) =>
      Array.from({ length: count }, () => ({
        ruleId: 'medium',
        description: '',
        file: '',
        startLine: 0,
        endLine: 0,
        match: '',
        secret: '',
        entropy: 0,
        tags: ['medium'] as ReadonlyArray<string>,
      }));
    // The threshold is `> 3` (strict). Pin every value 0..3 — a future tightening
    // to `>= 3` is the off-by-one we are guarding against.
    expect(shouldAbortReview(mk(0)).abort).toBe(false);
    expect(shouldAbortReview(mk(1)).abort).toBe(false);
    expect(shouldAbortReview(mk(2)).abort).toBe(false);
    expect(shouldAbortReview(mk(3)).abort).toBe(false);
  });
});

describe('scanWorkspaceWithGitleaks', () => {
  it('returns no findings on empty stdout', async () => {
    const spawnFn: SpawnFn = vi.fn(async () => ({ stdout: '', exitCode: 0 }));
    const result = await scanWorkspaceWithGitleaks({ workspace: '/tmp/x', spawnFn });
    expect(result.findings).toHaveLength(0);
    expect(result.aborted).toBe(false);
  });

  it('parses gitleaks JSON output', async () => {
    const stdout = JSON.stringify([
      {
        RuleID: 'aws-access-key',
        Description: 'AWS access key',
        File: 'src/.env',
        StartLine: 1,
        EndLine: 1,
        Match: 'AKIAIOSFODNN7EXAMPLE',
        Secret: 'AKIAIOSFODNN7EXAMPLE',
        Entropy: 4.5,
        Tags: ['high'],
      },
    ]);
    const spawnFn: SpawnFn = vi.fn(async () => ({ stdout, exitCode: 1 }));
    const result = await scanWorkspaceWithGitleaks({ workspace: '/tmp/x', spawnFn });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.ruleId).toBe('aws-access-key');
    expect(result.aborted).toBe(true);
  });

  it('fails closed on malformed JSON (does not silently treat as clean)', async () => {
    const spawnFn: SpawnFn = vi.fn(async () => ({ stdout: 'gitleaks: error', exitCode: 1 }));
    const promise = scanWorkspaceWithGitleaks({ workspace: '/tmp/x', spawnFn });
    await expect(promise).rejects.toBeInstanceOf(GitleaksScanError);
    await expect(promise).rejects.toMatchObject({
      kind: 'gitleaks-scan-failed',
      failureReason: 'malformed-json',
      exitCode: 1,
      stdoutExcerpt: 'gitleaks: error',
    });
  });

  it('fails closed when parsed JSON is not an array', async () => {
    const spawnFn: SpawnFn = vi.fn(async () => ({
      stdout: JSON.stringify({ findings: [] }),
      exitCode: 0,
    }));
    const promise = scanWorkspaceWithGitleaks({ workspace: '/tmp/x', spawnFn });
    await expect(promise).rejects.toBeInstanceOf(GitleaksScanError);
    await expect(promise).rejects.toMatchObject({
      failureReason: 'unexpected-shape',
      exitCode: 0,
    });
  });

  it('fails closed when stdout is empty but exit code reports leaks (1)', async () => {
    const spawnFn: SpawnFn = vi.fn(async () => ({ stdout: '   \n', exitCode: 1 }));
    const promise = scanWorkspaceWithGitleaks({ workspace: '/tmp/x', spawnFn });
    await expect(promise).rejects.toBeInstanceOf(GitleaksScanError);
    await expect(promise).rejects.toMatchObject({
      failureReason: 'empty-stdout-on-leak-exit',
      exitCode: 1,
      stdoutExcerpt: '',
    });
  });

  it('truncates stdoutExcerpt to a bounded slice on malformed output', async () => {
    const big = 'x'.repeat(2000);
    const spawnFn: SpawnFn = vi.fn(async () => ({ stdout: big, exitCode: 1 }));
    const promise = scanWorkspaceWithGitleaks({ workspace: '/tmp/x', spawnFn });
    await expect(promise).rejects.toMatchObject({ failureReason: 'malformed-json' });
    try {
      await promise;
    } catch (err) {
      const e = err as GitleaksScanError;
      // The error's stdoutExcerpt must be much smaller than the raw
      // payload so error logs cannot be used to spam the log pipeline
      // by feeding a huge garbage stdout.
      expect(e.stdoutExcerpt.length).toBeLessThanOrEqual(513);
      expect(e.stdoutExcerpt.endsWith('…')).toBe(true);
    }
  });

  it('propagates non-zero-non-1 spawn rejection (fail-closed by error propagation)', async () => {
    const spawnFn: SpawnFn = vi.fn(async () => {
      throw new Error('gitleaks exited 2: permission denied');
    });
    await expect(scanWorkspaceWithGitleaks({ workspace: '/tmp/x', spawnFn })).rejects.toThrow(
      /gitleaks exited 2/,
    );
  });

  it('passes --config when customRegexFile provided', async () => {
    const spawnFn = vi.fn(async () => ({ stdout: '', exitCode: 0 })) as ReturnType<
      typeof vi.fn<SpawnFn>
    >;
    await scanWorkspaceWithGitleaks({
      workspace: '/tmp/x',
      spawnFn: spawnFn as unknown as SpawnFn,
      customRegexFile: '/tmp/extra.toml',
    });
    const args = spawnFn.mock.calls[0]?.[1] as ReadonlyArray<string>;
    expect(args).toContain('--config');
    expect(args).toContain('/tmp/extra.toml');
  });
});
