import {
  ConfigError,
  ContextLengthError,
  CostExceededError,
  GitleaksScanError,
  ReviewAgentError,
  SchemaValidationError,
  SecretLeakAbortedError,
  ToolDispatchRefusedError,
} from '@review-agent/core';
import { describe, expect, it } from 'vitest';
import { classifyError } from '../error-classifier.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Construct a lightweight error object that quacks like an LLM provider
 * error (has a `kind` string matching one of the known LLM ErrorKind values).
 */
function llmError(kind: string): { kind: string } {
  return { kind };
}

// ---------------------------------------------------------------------------
// LLM provider errors
// ---------------------------------------------------------------------------

describe('classifyError — LLM transient kinds', () => {
  it.each(['rate_limit', 'overloaded', 'transient'] as const)(
    'classifies %s as transient',
    (kind) => {
      expect(classifyError(llmError(kind))).toBe('transient');
    },
  );
});

describe('classifyError — LLM permanent kinds', () => {
  it.each(['auth', 'fatal', 'context_length'] as const)('classifies %s as permanent', (kind) => {
    expect(classifyError(llmError(kind))).toBe('permanent');
  });
});

// ---------------------------------------------------------------------------
// ReviewAgentError subclasses
// ---------------------------------------------------------------------------

describe('classifyError — ReviewAgentError permanent subclasses', () => {
  it('classifies CostExceededError as permanent', () => {
    expect(classifyError(new CostExceededError(1.0, 1.5))).toBe('permanent');
  });

  it('classifies ContextLengthError as permanent', () => {
    expect(classifyError(new ContextLengthError(100_000, 120_000))).toBe('permanent');
  });

  it('classifies ConfigError as permanent', () => {
    expect(classifyError(new ConfigError('bad config'))).toBe('permanent');
  });

  it('classifies SchemaValidationError as permanent', () => {
    expect(classifyError(new SchemaValidationError('bad schema', []))).toBe('permanent');
  });

  it('classifies ToolDispatchRefusedError as permanent', () => {
    expect(classifyError(new ToolDispatchRefusedError('read_file', 'denied'))).toBe('permanent');
  });

  it('classifies SecretLeakAbortedError as permanent', () => {
    expect(classifyError(new SecretLeakAbortedError('diff', 1, ['rule-1'], 'test'))).toBe(
      'permanent',
    );
  });

  it('classifies GitleaksScanError as permanent', () => {
    expect(classifyError(new GitleaksScanError('malformed-json', 1, 'stdout-excerpt'))).toBe(
      'permanent',
    );
  });
});

// ---------------------------------------------------------------------------
// Unknown errors — must default to transient
// ---------------------------------------------------------------------------

describe('classifyError — unknown / unrecognised errors default to transient', () => {
  it('classifies a plain Error as transient', () => {
    expect(classifyError(new Error('unexpected'))).toBe('transient');
  });

  it('classifies a string as transient', () => {
    expect(classifyError('some string error')).toBe('transient');
  });

  it('classifies null as transient', () => {
    expect(classifyError(null)).toBe('transient');
  });

  it('classifies undefined as transient', () => {
    expect(classifyError(undefined)).toBe('transient');
  });

  it('classifies an object with an unknown kind as transient (not an LLM error shape)', () => {
    // An object with a `kind` that is not a known LLM ErrorKind falls through
    // the structural guard and is treated as an unknown error (transient).
    expect(classifyError({ kind: 'unknown-future-kind' })).toBe('transient');
  });

  it('classifies a ReviewAgentError subclass with an unknown kind as transient', () => {
    // Simulate a future ReviewAgentError subclass whose kind is not yet listed.
    class FutureError extends ReviewAgentError {
      // biome-ignore lint/suspicious/noExplicitAny: intentionally testing unknown kind
      readonly kind = 'some-future-kind' as any;
    }
    expect(classifyError(new FutureError('future'))).toBe('transient');
  });
});
