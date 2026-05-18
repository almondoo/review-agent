import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitleaksScanError } from '@review-agent/core';

export type GitleaksFinding = {
  readonly ruleId: string;
  readonly description: string;
  readonly file: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly match: string;
  readonly secret: string;
  readonly entropy: number;
  readonly tags: ReadonlyArray<string>;
};

export type GitleaksResult = {
  readonly findings: ReadonlyArray<GitleaksFinding>;
  readonly aborted: boolean;
  readonly reason: string | null;
};

const ABORT_THRESHOLD_FINDINGS = 3;
const HIGH_ENTROPY_THRESHOLD = 4.5;

export type SpawnFn = (
  command: string,
  args: ReadonlyArray<string>,
  opts: { readonly timeout?: number; readonly cwd?: string },
) => Promise<{ readonly stdout: string; readonly exitCode: number }>;

// Hard cap on buffered stdout from the gitleaks process. Without this a
// malicious PR can drive gitleaks (or any subprocess masquerading as it
// via `binaryPath` injection) into emitting gigabytes of bogus output
// faster than the 60s timeout can fire, OOM-killing the runner. The
// scanner's legitimate JSON output for a normal PR is well under 1 MB;
// 16 MB is generous slack for adversarial-but-still-recoverable runs.
// (audit-w1 W1-B03 sec H-2)
export const MAX_STDOUT_BYTES = 16 * 1024 * 1024;

export const defaultSpawn: SpawnFn = (command, args, opts) =>
  new Promise((resolve, reject) => {
    const proc = spawn(command, [...args], {
      cwd: opts.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: opts.timeout ?? 60_000,
    });
    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let killed = false;
    proc.stdout.on('data', (d: Buffer | string) => {
      if (killed) return;
      const chunkBytes = typeof d === 'string' ? Buffer.byteLength(d) : d.length;
      if (stdoutBytes + chunkBytes > MAX_STDOUT_BYTES) {
        killed = true;
        // Drop the buffered payload entirely — we cannot trust any
        // partial JSON we managed to buffer, and the excerpt would
        // be likely to contain secret values anyway. SIGKILL because
        // SIGTERM may be ignored by a misbehaving child.
        stdout = '';
        proc.kill('SIGKILL');
        reject(new GitleaksScanError('stdout-too-large', -1, ''));
        return;
      }
      stdoutBytes += chunkBytes;
      stdout += d.toString();
    });
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (killed) return;
      if (code === 0 || code === 1) {
        resolve({ stdout, exitCode: code ?? 0 });
        return;
      }
      reject(new Error(`gitleaks exited ${code}: ${stderr.trim()}`));
    });
  });

export type ScanDiffOptions = {
  readonly workspace: string;
  readonly spawnFn?: SpawnFn;
  readonly binaryPath?: string;
  readonly customRegexFile?: string;
};

export async function scanWorkspaceWithGitleaks(opts: ScanDiffOptions): Promise<GitleaksResult> {
  const spawnFn = opts.spawnFn ?? defaultSpawn;
  const binary = opts.binaryPath ?? 'gitleaks';
  const args: string[] = [
    'detect',
    '--source',
    opts.workspace,
    '--report-format',
    'json',
    '--no-banner',
    '--exit-code',
    '1',
  ];
  if (opts.customRegexFile) args.push('--config', opts.customRegexFile);
  try {
    return await runGitleaks(spawnFn, binary, args);
  } catch (err) {
    // gitleaks exits non-0/non-1 when its config fails to load — the
    // most common cause once `customRegexFile` is wired in is an
    // operator pattern that compiles under V8 (the engine
    // `isValidRegex` uses) but not under Go's RE2 (the engine
    // gitleaks uses). Backreferences (`\1`), lookbehind (`(?<=…)`),
    // and lookahead (`(?=…)`) are the usual culprits. Catch the
    // bare Error, sniff stderr for the giveaway phrases, and
    // re-throw with a docs pointer so the operator does not have
    // to decode raw Go runtime output. Errors that don't look like
    // a regex parse failure pass through unchanged.
    if (opts.customRegexFile && err instanceof Error && !(err instanceof GitleaksScanError)) {
      const msg = err.message.toLowerCase();
      if (
        msg.includes('error parsing regexp') ||
        msg.includes('cannot compile') ||
        msg.includes('invalid or unsupported perl syntax')
      ) {
        throw new Error(
          `${err.message}\n\nHint: gitleaks compiles patterns with Go's RE2 engine, which is a strict subset of JavaScript regex — backreferences (\\1), lookbehind ((?<=…)), and lookahead ((?=…)) are NOT supported. Adjust the offending privacy.redact_patterns entry. See docs/configuration/privacy.md for the RE2 constraints.`,
        );
      }
    }
    throw err;
  }
}

const HIGH_ENTROPY_PATTERNS: ReadonlyArray<RegExp> = [/[A-Za-z0-9+/=]{40,}/g];

/**
 * `id` prefix for findings emitted by user-supplied
 * `privacy.redact_patterns` (spec §7.4). Surfaces in
 * `[REDACTED:custom-N]` replacement tokens — operators can grep the
 * placeholder back to the source `.review-agent.yml` entry. Kept as a
 * named export so the test suite, the docs, and the agent loop can
 * share a single source of truth.
 */
export const CUSTOM_RULE_ID_PREFIX = 'custom-';

/**
 * Sentinel sequence the TOML multi-line literal form (`'''…'''`)
 * cannot contain. `liftCustomPatternsToToml` rejects patterns
 * carrying this sequence rather than silently truncating the regex
 * at the terminator boundary — operators must restructure those
 * exotic patterns. `isValidRegex` accepts `'''` (it is valid JS
 * regex source), so this check is the only line of defence against
 * a config-load syntax error inside gitleaks.
 */
const TOML_LITERAL_TERMINATOR = "'''";

/**
 * Lift operator-supplied `privacy.redact_patterns` entries into a
 * gitleaks TOML config fragment (spec §7.4). Each entry becomes a
 * `[[rules]]` block with a stable, deterministic id
 * (`custom-${index}`) so findings can be cross-referenced back to
 * the source array position. Built-in rules are unaffected — the
 * lifted fragment is layered on top of gitleaks' default ruleset
 * via the `[extend] useDefault = true` directive, because gitleaks'
 * `--config` flag REPLACES the default ruleset without that flag
 * (which would silently drop every built-in AWS / GitHub /
 * Anthropic / OpenAI / PEM detector — the exact "extend, not relax"
 * failure §7.4 forbids).
 *
 * Regex values are emitted as TOML **multi-line literal strings**
 * (`'''…'''`) so backslash, double-quote, dollar-sign, and embedded
 * newlines pass through verbatim — `\d{4}` written in YAML reaches
 * Go's RE2 compiler as exactly `\d{4}`, no double-escape footgun.
 * The one shape literal strings cannot carry is the terminator
 * `'''` itself; we throw a clear error when a pattern contains it
 * so gitleaks never sees malformed TOML.
 *
 * Returns an empty string when `patterns` is empty so callers can
 * skip the tempfile dance entirely.
 *
 * RE2 subset note: `isValidRegex` validates patterns under V8's
 * regex engine (correct for the in-process `quickScanContent`
 * fallback), but gitleaks runs Go's RE2, a strict subset of V8.
 * Features like backreferences (`\1`), lookbehind (`(?<=…)`), and
 * lookahead (`(?=…)`) compile here but reject inside gitleaks.
 * `scanWorkspaceWithGitleaks` surfaces the resulting config-load
 * failure with a docs hint (see the stderr-inspection wrapper
 * around `runGitleaks`); `docs/configuration/privacy.md`
 * reproduces the constraint for operators.
 */
export function liftCustomPatternsToToml(patterns: ReadonlyArray<string>): string {
  if (patterns.length === 0) return '';
  const header = '[extend]\nuseDefault = true\n';
  const blocks = patterns
    .map((pattern, index) => {
      if (pattern.includes(TOML_LITERAL_TERMINATOR)) {
        throw new Error(
          `privacy.redact_patterns[${index}] contains the TOML multi-line literal terminator (''') — gitleaks config syntax cannot represent it. Restructure the pattern to avoid three consecutive single quotes.`,
        );
      }
      const id = `${CUSTOM_RULE_ID_PREFIX}${index}`;
      return [
        '[[rules]]',
        `id = "${id}"`,
        `description = "review-agent privacy.redact_patterns[${index}]"`,
        // Multi-line literal strings emit characters verbatim, no
        // escape pass at all — exactly the regex-source semantic we
        // want. A leading newline immediately after the opening
        // `'''` is trimmed by the TOML parser, so we keep the value
        // on the same line as the opening delimiter.
        `regex = '''${pattern}'''`,
        // `tags = ["high"]` mirrors the in-process `quickScanContent`
        // treatment of custom hits — operators explicitly listed
        // these patterns as secrets, so any match is high-confidence
        // by definition.
        'tags = ["high"]',
      ].join('\n');
    })
    .join('\n\n');
  return `${header}\n${blocks}\n`;
}

export type CustomRegexFile = {
  readonly path: string;
  readonly cleanup: () => Promise<void>;
};

export type WriteCustomRegexFileDeps = {
  readonly mkdtemp?: typeof mkdtemp;
  readonly writeFile?: typeof writeFile;
  readonly rm?: typeof rm;
  readonly tmpdir?: () => string;
};

/**
 * Materialize the lifted TOML fragment to a tempfile that
 * `scanWorkspaceWithGitleaks` can pass via `--config`. Returns `null`
 * when no patterns are supplied so the caller can skip the
 * try/finally entirely.
 *
 * Uses a fresh tempdir per call (rather than a single shared file)
 * so concurrent reviews on the same host — the Server-mode pattern —
 * don't race on a shared path. The caller owns cleanup via the
 * returned `cleanup()`; this module never garbage-collects.
 */
export async function writeCustomRegexFile(
  patterns: ReadonlyArray<string>,
  deps: WriteCustomRegexFileDeps = {},
): Promise<CustomRegexFile | null> {
  if (patterns.length === 0) return null;
  const mkdtempFn = deps.mkdtemp ?? mkdtemp;
  const writeFileFn = deps.writeFile ?? writeFile;
  const rmFn = deps.rm ?? rm;
  const tmp = (deps.tmpdir ?? tmpdir)();
  const dir = await mkdtempFn(join(tmp, 'review-agent-gitleaks-'));
  const path = join(dir, 'rules.toml');
  const toml = liftCustomPatternsToToml(patterns);
  await writeFileFn(path, toml, 'utf8');
  let cleaned = false;
  return {
    path,
    cleanup: async () => {
      if (cleaned) return;
      cleaned = true;
      await rmFn(dir, { recursive: true, force: true });
    },
  };
}

export function quickScanContent(
  content: string,
  customPatterns: ReadonlyArray<string> = [],
): GitleaksFinding[] {
  const findings: GitleaksFinding[] = [];
  const wellKnown: ReadonlyArray<{ id: string; pattern: RegExp }> = [
    { id: 'aws-access-key', pattern: /\bAKIA[0-9A-Z]{16}\b/g },
    { id: 'github-pat', pattern: /\bghp_[A-Za-z0-9]{36}\b/g },
    { id: 'github-pat-fine', pattern: /\bgithub_pat_[A-Za-z0-9_]{50,}\b/g },
    { id: 'anthropic-key', pattern: /\bsk-ant-[A-Za-z0-9-]{20,}\b/g },
    { id: 'openai-key', pattern: /\bsk-[A-Za-z0-9]{30,}\b/g },
    { id: 'gcp-service-account', pattern: /"type":\s*"service_account"/g },
    { id: 'private-key-block', pattern: /-----BEGIN [A-Z ]+ PRIVATE KEY-----/g },
  ];
  for (const { id, pattern } of wellKnown) {
    let match: RegExpExecArray | null = pattern.exec(content);
    while (match !== null) {
      findings.push({
        ruleId: id,
        description: `Built-in rule: ${id}`,
        file: '',
        startLine: lineFor(content, match.index),
        endLine: lineFor(content, match.index),
        match: match[0],
        secret: match[0],
        entropy: 0,
        tags: ['high'],
      });
      match = pattern.exec(content);
    }
  }
  for (const pattern of HIGH_ENTROPY_PATTERNS) {
    let match: RegExpExecArray | null = pattern.exec(content);
    while (match !== null) {
      const entropy = shannonEntropy(match[0]);
      if (entropy >= HIGH_ENTROPY_THRESHOLD) {
        findings.push({
          ruleId: 'high-entropy',
          description: `High-entropy string (${entropy.toFixed(2)})`,
          file: '',
          startLine: lineFor(content, match.index),
          endLine: lineFor(content, match.index),
          match: match[0],
          secret: match[0],
          entropy,
          tags: ['medium'],
        });
      }
      match = pattern.exec(content);
    }
  }
  // User-supplied `privacy.redact_patterns` (spec §7.4). These run
  // AFTER the built-ins so a string matched by both an operator
  // pattern and a built-in rule still gets the built-in's stable
  // ruleId in any first-wins downstream consumer — the redaction
  // dedups by `secret` anyway in `applyRedactions`. Each compile is
  // wrapped in try/catch defensively even though `isValidRegex` has
  // already validated the input at config-load time (T1); a corrupt
  // job message making it past validation should degrade to
  // "skip the bad pattern" rather than aborting the whole scan.
  //
  // ReDoS note: `isValidRegex` does NOT reject patterns prone to
  // catastrophic backtracking (e.g. `(a+)+`). The pre-prompt diff
  // scan is bounded by the diff size cap; the post-LLM output scan
  // is bounded by the LLM's response budget. Future hardening can
  // add a per-pattern execution timeout via `re2`/equivalent, but
  // that is out of scope for the initial wire-up.
  for (let i = 0; i < customPatterns.length; i++) {
    const raw = customPatterns[i] ?? '';
    let pattern: RegExp;
    try {
      pattern = new RegExp(raw, 'g');
    } catch {
      continue;
    }
    const id = `${CUSTOM_RULE_ID_PREFIX}${i}`;
    // `matchAll` advances `lastIndex` internally and refuses
    // zero-width matches by throwing — wrapping the loop in a
    // try-block plus the `.length === 0` short-circuit below
    // collapses both failure modes into a single "skip and move on".
    let iter: IterableIterator<RegExpMatchArray>;
    try {
      iter = content.matchAll(pattern);
    } catch {
      continue;
    }
    for (const m of iter) {
      const hit = m[0];
      // A zero-width hit (e.g. `^`, `\b`, `(?=foo)`) carries no
      // secret to redact and could otherwise spam the finding list
      // with empty `secret` entries that `applyRedactions` skips
      // anyway. Drop them up-front for clarity.
      if (hit === '') continue;
      const idx = m.index ?? 0;
      findings.push({
        ruleId: id,
        description: `Custom rule: ${id}`,
        file: '',
        startLine: lineFor(content, idx),
        endLine: lineFor(content, idx),
        match: hit,
        secret: hit,
        entropy: 0,
        tags: ['high'],
      });
    }
  }
  return findings;
}

export function applyRedactions(text: string, findings: ReadonlyArray<GitleaksFinding>): string {
  let out = text;
  for (const f of findings) {
    if (!f.secret) continue;
    out = out.split(f.secret).join(`[REDACTED:${f.ruleId}]`);
  }
  return out;
}

export function shouldAbortReview(findings: ReadonlyArray<GitleaksFinding>): {
  abort: boolean;
  reason: string | null;
} {
  if (findings.length > ABORT_THRESHOLD_FINDINGS) {
    return { abort: true, reason: `${findings.length} secret findings (>3)` };
  }
  for (const f of findings) {
    if (f.tags.includes('high')) {
      return { abort: true, reason: `high-confidence finding: ${f.ruleId}` };
    }
  }
  return { abort: false, reason: null };
}

// Cap on the stdout slice we surface in `GitleaksScanError.stdoutExcerpt`.
// Large enough to recognise gitleaks' usual error prefixes and short
// crash banners, small enough that the error message stays bounded
// regardless of how much garbage the process printed.
const STDOUT_EXCERPT_LIMIT = 512;

// Redact the `"Secret"` / `"Match"` (and lowercase variants) values from
// a JSON-ish payload BEFORE truncating, so callers that log
// `GitleaksScanError.stdoutExcerpt` to a shipping pipeline (Sentry /
// CloudWatch / etc.) cannot exfiltrate the very secrets the scanner was
// supposed to redact (audit-w1 W1-B03 sec H-1). We also re-run the
// in-repo `quickScanContent` patterns as a second layer so that bare
// `AKIA…` / `ghp_…` / `sk-ant-…` tokens that escaped the JSON-key form
// (e.g. embedded inside an error banner before the scanner crashed) are
// still neutralised. We intentionally over-redact — the excerpt only
// needs to identify the *shape* of the failure, not preserve content.
const SECRET_KEY_VALUE_PATTERN = /"(Secret|Match|secret|match)":\s*"(?:[^"\\]|\\.)*"/g;

function redactExcerpt(raw: string): string {
  const keyRedacted = raw.replace(SECRET_KEY_VALUE_PATTERN, '"$1":"[REDACTED]"');
  return applyRedactions(keyRedacted, quickScanContent(keyRedacted));
}

function excerptStdout(stdout: string): string {
  const safe = redactExcerpt(stdout);
  if (safe.length <= STDOUT_EXCERPT_LIMIT) return safe;
  return `${safe.slice(0, STDOUT_EXCERPT_LIMIT)}…`;
}

async function runGitleaks(
  spawnFn: SpawnFn,
  binary: string,
  args: ReadonlyArray<string>,
): Promise<GitleaksResult> {
  const result = await spawnFn(binary, args, { timeout: 60_000 });
  const stdoutTrimmed = result.stdout.trim();
  // exit 0 + empty stdout is the legitimate "no findings" case. exit 1
  // with empty stdout means gitleaks reported leaks via its exit code
  // but did not emit them — we cannot trust the run as clean, so we
  // fail closed.
  if (!stdoutTrimmed) {
    if (result.exitCode === 0) {
      return { findings: [], aborted: false, reason: null };
    }
    throw new GitleaksScanError('empty-stdout-on-leak-exit', result.exitCode, '');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(result.stdout);
  } catch (cause) {
    // Previously this was silently swallowed as "no findings", which
    // meant a corrupted scanner output looked identical to a clean run
    // and could hide a leak (audit-w1 W1-B03 / spec §7).
    throw new GitleaksScanError('malformed-json', result.exitCode, excerptStdout(result.stdout), {
      cause,
    });
  }
  if (!Array.isArray(raw)) {
    throw new GitleaksScanError('unexpected-shape', result.exitCode, excerptStdout(result.stdout));
  }
  const findings = raw.filter(isFindingShape).map(toFinding);
  const decision = shouldAbortReview(findings);
  return { findings, aborted: decision.abort, reason: decision.reason };
}

function isFindingShape(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function toFinding(raw: Record<string, unknown>): GitleaksFinding {
  return {
    ruleId: String(raw.RuleID ?? raw.ruleId ?? 'unknown'),
    description: String(raw.Description ?? raw.description ?? ''),
    file: String(raw.File ?? raw.file ?? ''),
    startLine: Number(raw.StartLine ?? raw.startLine ?? 0),
    endLine: Number(raw.EndLine ?? raw.endLine ?? 0),
    match: String(raw.Match ?? raw.match ?? ''),
    secret: String(raw.Secret ?? raw.secret ?? ''),
    entropy: Number(raw.Entropy ?? raw.entropy ?? 0),
    tags: Array.isArray(raw.Tags) ? (raw.Tags as string[]) : ['medium'],
  };
}

function lineFor(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < content.length; i++) {
    if (content[i] === '\n') line++;
  }
  return line;
}

function shannonEntropy(s: string): number {
  if (!s) return 0;
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let h = 0;
  for (const count of freq.values()) {
    const p = count / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}
