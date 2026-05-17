import { spawn } from 'node:child_process';
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
  return runGitleaks(spawnFn, binary, args);
}

const HIGH_ENTROPY_PATTERNS: ReadonlyArray<RegExp> = [/[A-Za-z0-9+/=]{40,}/g];

export function quickScanContent(content: string): GitleaksFinding[] {
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
