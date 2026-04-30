export type ReviewAgentErrorKind =
  | 'config'
  | 'schema'
  | 'cost-exceeded'
  | 'context-length'
  | 'tool-dispatch-refused';

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

export function isReviewAgentError(value: unknown): value is ReviewAgentError {
  return value instanceof ReviewAgentError;
}
