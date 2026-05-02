import { describe, expect, it } from 'vitest';
import { printSchemaCommand } from './schema.js';

function recordingIo() {
  const out: string[] = [];
  const err: string[] = [];
  let exitCode: number | null = null;
  return {
    out,
    err,
    get exitCode() {
      return exitCode;
    },
    stdout: (c: string) => {
      out.push(c);
    },
    stderr: (c: string) => {
      err.push(c);
    },
    exit: (code: number) => {
      exitCode = code;
    },
  };
}

describe('printSchemaCommand', () => {
  it('prints a JSON Schema describing the live ReviewAgentConfig', () => {
    const io = recordingIo();
    printSchemaCommand(io);
    const text = io.out.join('');
    expect(text.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(text) as Record<string, unknown>;
    // Pin specific fields. A regression to an empty `{}` would have passed
    // the previous `$schema ?? title ?? type` check.
    expect(parsed.$ref).toBe('#/definitions/ReviewAgentConfig');
    const defs = parsed.definitions as Record<string, { properties?: Record<string, unknown> }>;
    expect(defs.ReviewAgentConfig).toBeDefined();
    const props = defs.ReviewAgentConfig?.properties ?? {};
    for (const required of ['language', 'profile', 'reviews', 'cost', 'privacy']) {
      expect(props[required], `expected '${required}' in schema`).toBeDefined();
    }
  });
});
