import { describe, expect, it } from 'vitest';
import { buildProgram } from './program.js';

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

describe('buildProgram', () => {
  it('exposes the four top-level commands', () => {
    const program = buildProgram({ io: recordingIo(), env: {}, version: 'test' });
    const names = program.commands.map((c) => c.name());
    expect(names).toContain('review');
    expect(names).toContain('config');
    expect(names).toContain('eval');
    const config = program.commands.find((c) => c.name() === 'config');
    const subNames = config?.commands.map((c) => c.name());
    expect(subNames).toContain('validate');
    expect(subNames).toContain('schema');
  });

  it('wires `config schema` to print to stdout', async () => {
    const io = recordingIo();
    const program = buildProgram({ io, env: {}, version: 'test' });
    await program.parseAsync(['config', 'schema'], { from: 'user' });
    const text = io.out.join('');
    expect(text.length).toBeGreaterThan(0);
    expect(() => JSON.parse(text)).not.toThrow();
    expect(io.exitCode).toBe(0);
  });

  it('rejects an unknown profile via Commander choices', async () => {
    const io = recordingIo();
    const program = buildProgram({ io, env: {}, version: 'test' });
    await expect(() =>
      program.parseAsync(['review', '--repo', 'o/r', '--pr', '1', '--profile', 'wrong'], {
        from: 'user',
      }),
    ).rejects.toThrow();
  });

  it('exposes a --version flag', async () => {
    const io = recordingIo();
    const program = buildProgram({ io, env: {}, version: '9.9.9' });
    await expect(() => program.parseAsync(['--version'], { from: 'user' })).rejects.toThrow();
  });
});
