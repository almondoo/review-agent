import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  ContextLengthError,
  CostExceededError,
  isReviewAgentError,
  ReviewAgentError,
  SchemaValidationError,
  ToolDispatchRefusedError,
} from './errors.js';

describe('ReviewAgentError hierarchy', () => {
  it('every subclass is detected by isReviewAgentError', () => {
    expect(isReviewAgentError(new ConfigError('x'))).toBe(true);
    expect(isReviewAgentError(new SchemaValidationError('x', []))).toBe(true);
    expect(isReviewAgentError(new CostExceededError(1, 2))).toBe(true);
    expect(isReviewAgentError(new ContextLengthError(100, 200))).toBe(true);
    expect(isReviewAgentError(new ToolDispatchRefusedError('read_file', 'denied'))).toBe(true);
  });

  it('non-ReviewAgentError values are rejected by the type guard', () => {
    expect(isReviewAgentError(new Error('plain'))).toBe(false);
    expect(isReviewAgentError('string')).toBe(false);
    expect(isReviewAgentError(null)).toBe(false);
    expect(isReviewAgentError(undefined)).toBe(false);
    expect(isReviewAgentError({})).toBe(false);
  });

  it('subclasses inherit from ReviewAgentError and Error', () => {
    const err = new ConfigError('boom');
    expect(err).toBeInstanceOf(ReviewAgentError);
    expect(err).toBeInstanceOf(Error);
  });
});

describe('ConfigError', () => {
  it('exposes kind=config and optional path', () => {
    const err = new ConfigError('bad yaml', { path: '.review-agent.yml' });
    expect(err.kind).toBe('config');
    expect(err.path).toBe('.review-agent.yml');
    expect(err.name).toBe('ConfigError');
    expect(err.message).toBe('bad yaml');
  });

  it('defaults path to null', () => {
    expect(new ConfigError('oops').path).toBeNull();
  });

  it('preserves cause', () => {
    const cause = new Error('underlying');
    const err = new ConfigError('wrapped', { cause });
    expect(err.cause).toBe(cause);
  });
});

describe('SchemaValidationError', () => {
  it('exposes kind=schema and issues array', () => {
    const issues = [{ path: 'comments[0].body', message: 'broadcast mention' }];
    const err = new SchemaValidationError('invalid', issues);
    expect(err.kind).toBe('schema');
    expect(err.issues).toEqual(issues);
    expect(err.issues).toHaveLength(1);
  });

  it('preserves cause', () => {
    const cause = new Error('zod error');
    const err = new SchemaValidationError('invalid', [], { cause });
    expect(err.cause).toBe(cause);
  });
});

describe('CostExceededError', () => {
  it('exposes kind=cost-exceeded and cost numbers', () => {
    const err = new CostExceededError(2.0, 2.5);
    expect(err.kind).toBe('cost-exceeded');
    expect(err.limitUsd).toBe(2.0);
    expect(err.actualUsd).toBe(2.5);
    expect(err.message).toContain('limit=$2.0000');
    expect(err.message).toContain('actual=$2.5000');
  });
});

describe('ContextLengthError', () => {
  it('exposes kind=context-length and token counts', () => {
    const err = new ContextLengthError(200_000, 250_000);
    expect(err.kind).toBe('context-length');
    expect(err.limitTokens).toBe(200_000);
    expect(err.actualTokens).toBe(250_000);
    expect(err.message).toContain('200000');
    expect(err.message).toContain('250000');
  });
});

describe('ToolDispatchRefusedError', () => {
  it('exposes kind=tool-dispatch-refused, toolName, and reason', () => {
    const err = new ToolDispatchRefusedError('shell_exec', 'not whitelisted');
    expect(err.kind).toBe('tool-dispatch-refused');
    expect(err.toolName).toBe('shell_exec');
    expect(err.reason).toBe('not whitelisted');
    expect(err.message).toContain("'shell_exec'");
    expect(err.message).toContain('not whitelisted');
  });
});
