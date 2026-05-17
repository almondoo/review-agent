import { GitleaksScanError } from '@review-agent/core';
import { describe, expect, it, vi } from 'vitest';
import {
  applyRedactions,
  CUSTOM_RULE_ID_PREFIX,
  liftCustomPatternsToToml,
  quickScanContent,
  type SpawnFn,
  scanWorkspaceWithGitleaks,
  shouldAbortReview,
  writeCustomRegexFile,
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

describe('quickScanContent — custom redact_patterns (#87)', () => {
  it('emits findings tagged with the custom-N rule id when a custom pattern hits', () => {
    const findings = quickScanContent('INTERNAL-TOKEN-12345 in code', ['INTERNAL-TOKEN-\\d+']);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.ruleId).toBe(`${CUSTOM_RULE_ID_PREFIX}0`);
    expect(findings[0]?.secret).toBe('INTERNAL-TOKEN-12345');
    expect(findings[0]?.tags).toEqual(['high']);
  });

  it('uses positional ids so multiple custom patterns are distinguishable', () => {
    const findings = quickScanContent('FOO-1 then BAR-2', ['FOO-\\d', 'BAR-\\d']);
    expect(findings.map((f) => f.ruleId).sort()).toEqual([
      `${CUSTOM_RULE_ID_PREFIX}0`,
      `${CUSTOM_RULE_ID_PREFIX}1`,
    ]);
  });

  it('keeps built-in matches active alongside custom patterns (overlap case)', () => {
    // `AKIA...` hits the built-in aws-access-key rule AND the operator's
    // custom `AKIA.*` rule. Both should appear — operators should see
    // their custom rule fire even when a built-in already caught it,
    // since the redaction layer dedups by secret string anyway.
    const findings = quickScanContent('AKIAIOSFODNN7EXAMPLE', ['AKIA[A-Z0-9]+']);
    const ids = findings.map((f) => f.ruleId);
    expect(ids).toContain('aws-access-key');
    expect(ids).toContain(`${CUSTOM_RULE_ID_PREFIX}0`);
  });

  it('matches every occurrence of a custom pattern (global flag)', () => {
    const findings = quickScanContent('X-1 X-2 X-3', ['X-\\d']);
    expect(findings.filter((f) => f.ruleId === `${CUSTOM_RULE_ID_PREFIX}0`)).toHaveLength(3);
  });

  it('drops zero-width custom patterns without infinite looping', () => {
    // `^` matches an empty position. Without the zero-width guard the
    // matchAll loop or its underlying engine would spin or emit empty
    // findings; with it, the pattern is silently dropped.
    const findings = quickScanContent('abc', ['^']);
    expect(findings).toHaveLength(0);
  });

  it('defaults customPatterns to [] (built-in scan still runs)', () => {
    // Back-compat assertion: existing call sites that pass only the
    // content arg must keep working.
    const findings = quickScanContent('AKIAIOSFODNN7EXAMPLE');
    expect(findings).toHaveLength(1);
    expect(findings[0]?.ruleId).toBe('aws-access-key');
  });

  it('produces [REDACTED:custom-N] tokens when threaded through applyRedactions', () => {
    const input = 'leak INTERNAL-TOKEN-12345 leak';
    const findings = quickScanContent(input, ['INTERNAL-TOKEN-\\d+']);
    const out = applyRedactions(input, findings);
    expect(out).not.toContain('INTERNAL-TOKEN-12345');
    expect(out).toContain(`[REDACTED:${CUSTOM_RULE_ID_PREFIX}0]`);
  });
});

describe('liftCustomPatternsToToml (#87)', () => {
  it('returns empty string for an empty list (caller skips tempfile)', () => {
    expect(liftCustomPatternsToToml([])).toBe('');
  });

  it('emits one [[rules]] block per pattern with positional ids and the regex value', () => {
    const out = liftCustomPatternsToToml(['AKIA[0-9A-Z]{16}', 'ghp_[A-Za-z0-9]{36}']);
    expect(out).toContain('[[rules]]');
    expect(out).toContain('id = "custom-0"');
    expect(out).toContain('id = "custom-1"');
    // Multi-line literal form — no escapes inside the regex value.
    expect(out).toContain("regex = '''AKIA[0-9A-Z]{16}'''");
    expect(out).toContain("regex = '''ghp_[A-Za-z0-9]{36}'''");
    expect(out.match(/\[\[rules\]\]/g)).toHaveLength(2);
  });

  it('keeps gitleaks built-in rules active via [extend] useDefault = true', () => {
    // Spec §7.4 "extend, not relax": without `useDefault = true`, the
    // gitleaks --config flag REPLACES the default ruleset and we
    // silently lose every built-in AWS/GitHub/Anthropic/OpenAI/PEM
    // detector. This is the most important invariant of the helper.
    const out = liftCustomPatternsToToml(['anything']);
    expect(out).toMatch(/\[extend\]/);
    expect(out).toMatch(/useDefault\s*=\s*true/);
  });

  it("emits regex values as TOML '''literal''' strings so backslashes survive verbatim (reviewer M-2)", () => {
    // Reviewer M-2: basic strings ("…") force a \\ / \" / \n escape
    // pass that is easy to get wrong. Multi-line literals ('''…''')
    // pass every byte through unchanged, so `\d{4}` written in YAML
    // arrives at Go's RE2 compiler as exactly `\d{4}`.
    const out = liftCustomPatternsToToml(['\\d{4}-\\d{4}']);
    expect(out).toContain("regex = '''\\d{4}-\\d{4}'''");
  });

  it('round-trips a double-quote without escape (literal-string semantic)', () => {
    const out = liftCustomPatternsToToml(['"quoted"']);
    expect(out).toContain("regex = '''\"quoted\"'''");
  });

  it('round-trips a dollar sign without escape', () => {
    // `$` is not special in any TOML string form, but it IS special
    // in some shells / templating engines — pin it so a future
    // misguided escape doesn't slip in.
    const out = liftCustomPatternsToToml(['^password=\\$secret']);
    expect(out).toContain("regex = '''^password=\\$secret'''");
  });

  it('round-trips an embedded newline as a literal byte (multi-line literal allows it)', () => {
    const out = liftCustomPatternsToToml(['line1\nline2']);
    expect(out).toContain("regex = '''line1\nline2'''");
  });

  it("rejects a pattern containing the TOML literal terminator ''' (reviewer M-2 edge case)", () => {
    // Multi-line literal strings cannot contain `'''`. Rather than
    // re-encode to basic-string form (which re-introduces the
    // escape footgun the literal form was meant to dodge), throw a
    // clear error so the operator restructures the pattern.
    expect(() => liftCustomPatternsToToml(["foo'''bar"])).toThrow(
      /TOML multi-line literal terminator/,
    );
  });

  it('tags every custom rule "high" so any match aborts the review like a built-in high-confidence hit', () => {
    const out = liftCustomPatternsToToml(['anything']);
    expect(out).toContain('tags = ["high"]');
  });
});

describe('writeCustomRegexFile (#87)', () => {
  it('returns null for an empty pattern list (caller skips try/finally)', async () => {
    const result = await writeCustomRegexFile([]);
    expect(result).toBeNull();
  });

  it('writes the lifted TOML to a fresh tempdir and exposes cleanup', async () => {
    const writeFile = vi.fn<(p: string, c: string, e: string) => Promise<void>>(async () => {});
    const mkdtemp = vi.fn<(prefix: string) => Promise<string>>(async () => '/tmp/ra-fake-abc');
    const rmFn = vi.fn<(p: string, opts: object) => Promise<void>>(async () => {});
    const result = await writeCustomRegexFile(['AKIA[0-9A-Z]{16}'], {
      writeFile: writeFile as unknown as typeof import('node:fs/promises').writeFile,
      mkdtemp: mkdtemp as unknown as typeof import('node:fs/promises').mkdtemp,
      rm: rmFn as unknown as typeof import('node:fs/promises').rm,
      tmpdir: () => '/tmp',
    });
    expect(result).not.toBeNull();
    expect(result?.path).toBe('/tmp/ra-fake-abc/rules.toml');
    // mkdtemp got a prefix path under our injected tmpdir.
    expect(mkdtemp).toHaveBeenCalledWith('/tmp/review-agent-gitleaks-');
    // The TOML body contains the rule we asked to lift.
    const [, body] = writeFile.mock.calls[0] ?? [];
    expect(body).toContain('id = "custom-0"');
    expect(body).toContain("regex = '''AKIA[0-9A-Z]{16}'''");
    expect(body).toContain('useDefault = true');
    // cleanup() removes the dir.
    await result?.cleanup();
    expect(rmFn).toHaveBeenCalledWith('/tmp/ra-fake-abc', {
      recursive: true,
      force: true,
    });
  });

  it('cleanup() is idempotent (second call is a no-op)', async () => {
    const rmFn = vi.fn<(p: string, opts: object) => Promise<void>>(async () => {});
    const result = await writeCustomRegexFile(['x'], {
      writeFile: (async () => {}) as unknown as typeof import('node:fs/promises').writeFile,
      mkdtemp: (async () =>
        '/tmp/ra-fake-xyz') as unknown as typeof import('node:fs/promises').mkdtemp,
      rm: rmFn as unknown as typeof import('node:fs/promises').rm,
      tmpdir: () => '/tmp',
    });
    await result?.cleanup();
    await result?.cleanup();
    expect(rmFn).toHaveBeenCalledTimes(1);
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

  it('wraps a gitleaks regex-compile failure with a RE2-subset docs hint (#87 reviewer M-1)', async () => {
    // gitleaks compiles patterns with Go's RE2, which is a strict
    // subset of V8 regex — backreferences / lookbehind / lookahead
    // are rejected even though `isValidRegex` accepts them. When
    // that fires we want the operator to see a docs pointer, not
    // a raw Go runtime backtrace.
    const spawnFn: SpawnFn = vi.fn(async () => {
      throw new Error(
        'gitleaks exited 2: error parsing regexp: invalid or unsupported Perl syntax: `(?<=`',
      );
    });
    await expect(
      scanWorkspaceWithGitleaks({
        workspace: '/tmp/x',
        spawnFn,
        customRegexFile: '/tmp/extra.toml',
      }),
    ).rejects.toThrow(/RE2 engine.*subset of JavaScript regex/s);
    await expect(
      scanWorkspaceWithGitleaks({
        workspace: '/tmp/x',
        spawnFn,
        customRegexFile: '/tmp/extra.toml',
      }),
    ).rejects.toThrow(/docs\/configuration\/privacy\.md/);
  });

  it('leaves the bare error alone when no customRegexFile is in play (reviewer M-1)', async () => {
    // Without operator-supplied patterns there is no RE2 subset
    // mismatch to hint at — surface the raw error so the operator
    // sees the actual underlying cause.
    const spawnFn: SpawnFn = vi.fn(async () => {
      throw new Error('gitleaks exited 2: permission denied');
    });
    await expect(scanWorkspaceWithGitleaks({ workspace: '/tmp/x', spawnFn })).rejects.toThrow(
      /^gitleaks exited 2: permission denied$/,
    );
  });

  it('does not falsely tag a non-regex error as an RE2 mismatch (reviewer M-1)', async () => {
    // The wrap only fires when stderr mentions parse/regex/regexp/
    // compile keywords. Other errors that surface via the catch
    // branch (permission denied, missing binary, etc.) must pass
    // through verbatim even when `customRegexFile` is set.
    const spawnFn: SpawnFn = vi.fn(async () => {
      throw new Error('gitleaks exited 2: permission denied opening source directory');
    });
    await expect(
      scanWorkspaceWithGitleaks({
        workspace: '/tmp/x',
        spawnFn,
        customRegexFile: '/tmp/extra.toml',
      }),
    ).rejects.toThrow(/^gitleaks exited 2: permission denied opening source directory$/);
  });

  // H-1 (audit-w1 W1-B03 sec): `GitleaksScanError.stdoutExcerpt` is the
  // most likely place for a real Secret value to leak into shipping
  // logs. Even though we never silently treat malformed scanner output
  // as clean any more, callers will typically log the error with all
  // its structured fields, so the excerpt itself must already be
  // redacted by the time it leaves this module.
  it('redacts JSON "Secret" / "Match" key values in stdoutExcerpt', async () => {
    // Valid JSON shape but wrong top-level type → `unexpected-shape`
    // path runs through excerptStdout with the secret values present.
    const payload = JSON.stringify({
      findings: [
        {
          RuleID: 'aws-access-key',
          Match: 'AKIAIOSFODNN7EXAMPLE',
          Secret: 'AKIAIOSFODNN7EXAMPLE',
        },
        {
          RuleID: 'anthropic-key',
          match: `sk-ant-${'a'.repeat(40)}`,
          secret: `sk-ant-${'a'.repeat(40)}`,
        },
      ],
    });
    const spawnFn: SpawnFn = vi.fn(async () => ({ stdout: payload, exitCode: 0 }));
    try {
      await scanWorkspaceWithGitleaks({ workspace: '/tmp/x', spawnFn });
      throw new Error('expected throw');
    } catch (err) {
      const e = err as GitleaksScanError;
      expect(e.failureReason).toBe('unexpected-shape');
      // Neither raw secret value may survive into the excerpt — that
      // string is exactly what an attacker can drive the scanner to
      // emit and is what gets shipped to Sentry / CloudWatch.
      expect(e.stdoutExcerpt).not.toContain('AKIAIOSFODNN7EXAMPLE');
      expect(e.stdoutExcerpt).not.toContain('sk-ant-');
      // Defense-in-depth check: the placeholder is present so we know
      // redaction actually ran (rather than the excerpt being empty
      // for an unrelated reason).
      expect(e.stdoutExcerpt).toContain('[REDACTED');
    }
  });

  it('redacts bare AKIA/ghp/sk-ant tokens that appear outside of JSON keys', async () => {
    // Simulate a crashed gitleaks dumping a stack trace that includes a
    // raw token (e.g. it was reading the file when it panicked). The
    // payload is not even valid JSON → malformed-json path. The
    // excerpt MUST still strip the raw token.
    const stdout = `panic: ghp_${'A'.repeat(36)} unexpected EOF\n  at runtime.go:42`;
    const spawnFn: SpawnFn = vi.fn(async () => ({ stdout, exitCode: 1 }));
    try {
      await scanWorkspaceWithGitleaks({ workspace: '/tmp/x', spawnFn });
      throw new Error('expected throw');
    } catch (err) {
      const e = err as GitleaksScanError;
      expect(e.failureReason).toBe('malformed-json');
      expect(e.stdoutExcerpt).not.toContain(`ghp_${'A'.repeat(36)}`);
      expect(e.stdoutExcerpt).toContain('[REDACTED:github-pat]');
    }
  });

  // H-2 (audit-w1 W1-B03 sec): the in-process stdout buffer must be
  // capped so a malicious PR cannot OOM the runner by driving gitleaks
  // into emitting GB-scale output before the 60s timeout fires. We
  // can't easily test the real `defaultSpawn` here without spawning a
  // child, so we exercise the cap directly via the exported MAX_STDOUT_BYTES
  // and a SpawnFn that emulates the overflow rejection.
  it('exposes MAX_STDOUT_BYTES at a sane order of magnitude', async () => {
    const { MAX_STDOUT_BYTES } = await import('./gitleaks.js');
    // Sanity: must be bounded (no Infinity, no 0) and within 1-256 MB.
    expect(MAX_STDOUT_BYTES).toBeGreaterThan(1024 * 1024);
    expect(MAX_STDOUT_BYTES).toBeLessThanOrEqual(256 * 1024 * 1024);
  });

  it('propagates a GitleaksScanError(stdout-too-large) when spawnFn rejects with one', async () => {
    // This mirrors the behaviour `defaultSpawn` will exhibit when the
    // child process floods stdout past MAX_STDOUT_BYTES: SIGKILL +
    // reject with a stdout-too-large error and exitCode=-1.
    const spawnFn: SpawnFn = vi.fn(async () => {
      throw new GitleaksScanError('stdout-too-large', -1, '');
    });
    const promise = scanWorkspaceWithGitleaks({ workspace: '/tmp/x', spawnFn });
    await expect(promise).rejects.toBeInstanceOf(GitleaksScanError);
    await expect(promise).rejects.toMatchObject({
      failureReason: 'stdout-too-large',
      exitCode: -1,
      stdoutExcerpt: '',
    });
  });
});

describe('defaultSpawn stdout cap (H-2)', () => {
  it('kills the child and rejects with stdout-too-large when stdout exceeds MAX_STDOUT_BYTES', async () => {
    const { defaultSpawn, MAX_STDOUT_BYTES } = await import('./gitleaks.js');
    // `yes` prints "y\n" forever — perfect cheap stdout flood. Most
    // POSIX systems ship it; skip the test if not available.
    const which = await import('node:child_process').then(
      (cp) => cp.spawnSync('which', ['yes']).status,
    );
    if (which !== 0) {
      // Avoid a noisy fail on minimal CI images.
      return;
    }
    expect(MAX_STDOUT_BYTES).toBeGreaterThan(0);
    const start = Date.now();
    await expect(defaultSpawn('yes', [], { timeout: 30_000 })).rejects.toMatchObject({
      kind: 'gitleaks-scan-failed',
      failureReason: 'stdout-too-large',
    });
    // The cap must kick in well before any reasonable timeout — `yes`
    // produces ~16 MB in milliseconds on modern hardware. Allow generous
    // headroom for slow CI runners but still well under the 30s timeout.
    expect(Date.now() - start).toBeLessThan(25_000);
  }, 30_000);
});
