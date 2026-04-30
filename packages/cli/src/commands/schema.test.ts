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
  it('prints the JSON Schema to stdout', () => {
    const io = recordingIo();
    printSchemaCommand(io);
    const text = io.out.join('');
    const parsed = JSON.parse(text) as Record<string, unknown>;
    expect(parsed.$schema ?? parsed.title ?? parsed.type).toBeDefined();
    expect(text.endsWith('\n')).toBe(true);
  });
});
