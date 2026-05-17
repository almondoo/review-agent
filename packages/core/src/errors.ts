export type ReviewAgentErrorKind =
  | 'config'
  | 'schema'
  | 'cost-exceeded'
  | 'context-length'
  | 'tool-dispatch-refused'
  | 'secret-leak-aborted'
  | 'gitleaks-scan-failed';

export abstract class ReviewAgentError extends Error {
  abstract readonly kind: ReviewAgentErrorKind;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class ConfigError extends ReviewAgentError {
  readonly kind = 'config' as const;
  readonly path: string | null;

  constructor(message: string, options?: { cause?: unknown; path?: string }) {
    super(message, options);
    this.path = options?.path ?? null;
  }
}

export class SchemaValidationError extends ReviewAgentError {
  readonly kind = 'schema' as const;
  readonly issues: ReadonlyArray<{ path: string; message: string }>;

  constructor(
    message: string,
    issues: ReadonlyArray<{ path: string; message: string }>,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.issues = issues;
  }
}

export class CostExceededError extends ReviewAgentError {
  readonly kind = 'cost-exceeded' as const;
  readonly limitUsd: number;
  readonly actualUsd: number;

  constructor(limitUsd: number, actualUsd: number, options?: { cause?: unknown }) {
    super(
      `Cost cap exceeded: limit=$${limitUsd.toFixed(4)} actual=$${actualUsd.toFixed(4)}`,
      options,
    );
    this.limitUsd = limitUsd;
    this.actualUsd = actualUsd;
  }
}

export class ContextLengthError extends ReviewAgentError {
  readonly kind = 'context-length' as const;
  readonly limitTokens: number;
  readonly actualTokens: number;

  constructor(limitTokens: number, actualTokens: number, options?: { cause?: unknown }) {
    super(
      `Context length exceeded: limit=${limitTokens} tokens actual=${actualTokens} tokens`,
      options,
    );
    this.limitTokens = limitTokens;
    this.actualTokens = actualTokens;
  }
}

export class ToolDispatchRefusedError extends ReviewAgentError {
  readonly kind = 'tool-dispatch-refused' as const;
  readonly toolName: string;
  readonly reason: string;

  constructor(toolName: string, reason: string, options?: { cause?: unknown }) {
    super(`Tool '${toolName}' refused: ${reason}`, options);
    this.toolName = toolName;
    this.reason = reason;
  }
}

export const SECRET_LEAK_PHASES = ['diff', 'output'] as const;
export type SecretLeakPhase = (typeof SECRET_LEAK_PHASES)[number];

export class SecretLeakAbortedError extends ReviewAgentError {
  readonly kind = 'secret-leak-aborted' as const;
  readonly phase: SecretLeakPhase;
  readonly findingsCount: number;
  readonly ruleIds: ReadonlyArray<string>;
  readonly reason: string;

  constructor(
    phase: SecretLeakPhase,
    findingsCount: number,
    ruleIds: ReadonlyArray<string>,
    reason: string,
    options?: { cause?: unknown },
  ) {
    super(`Secret-leak post-scan aborted review (${phase}): ${reason}`, options);
    this.phase = phase;
    this.findingsCount = findingsCount;
    this.ruleIds = ruleIds;
    this.reason = reason;
  }
}

// Fail-closed reasons emitted when the gitleaks post-scan cannot be trusted.
// `malformed-json` covers a stdout payload that did not parse as JSON; the
// scanner may have crashed mid-write or had its output corrupted, so we
// cannot infer "no leaks" from it. `unexpected-shape` covers parsed JSON
// that is not the expected top-level array. `empty-stdout-on-leak-exit`
// covers exitCode=1 (gitleaks: "leaks found") combined with empty stdout —
// gitleaks claims findings exist but did not emit them, so we cannot
// redact what we did not see. `stdout-too-large` covers a runaway scanner
// that flooded stdout past the byte cap (DoS / OOM defense) — we kill
// the process and refuse to keep buffering. All four force the caller to
// surface a scan failure rather than silently treat the run as clean.
export const GITLEAKS_SCAN_FAILURES = [
  'malformed-json',
  'unexpected-shape',
  'empty-stdout-on-leak-exit',
  'stdout-too-large',
] as const;
export type GitleaksScanFailureReason = (typeof GITLEAKS_SCAN_FAILURES)[number];

export class GitleaksScanError extends ReviewAgentError {
  readonly kind = 'gitleaks-scan-failed' as const;
  readonly failureReason: GitleaksScanFailureReason;
  readonly exitCode: number;
  readonly stdoutExcerpt: string;

  constructor(
    failureReason: GitleaksScanFailureReason,
    exitCode: number,
    stdoutExcerpt: string,
    options?: { cause?: unknown },
  ) {
    super(
      `Gitleaks scan failed (${failureReason}, exit=${exitCode}); failing review closed`,
      options,
    );
    this.failureReason = failureReason;
    this.exitCode = exitCode;
    this.stdoutExcerpt = stdoutExcerpt;
  }
}

export function isReviewAgentError(value: unknown): value is ReviewAgentError {
  return value instanceof ReviewAgentError;
}
