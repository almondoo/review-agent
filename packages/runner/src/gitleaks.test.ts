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

  it('does not abort on 0–3 medium findings', () => {
    const two = Array.from({ length: 2 }, () => ({
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
    expect(shouldAbortReview(two).abort).toBe(false);
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

  it('tolerates non-JSON output (returns empty)', async () => {
    const spawnFn: SpawnFn = vi.fn(async () => ({ stdout: 'gitleaks: error', exitCode: 1 }));
    const result = await scanWorkspaceWithGitleaks({ workspace: '/tmp/x', spawnFn });
    expect(result.findings).toHaveLength(0);
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
