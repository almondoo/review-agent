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
  it('exposes the top-level commands including setup', () => {
    const program = buildProgram({ io: recordingIo(), env: {}, version: 'test' });
    const names = program.commands.map((c) => c.name());
    expect(names).toContain('review');
    expect(names).toContain('config');
    expect(names).toContain('eval');
    expect(names).toContain('setup');
    const config = program.commands.find((c) => c.name() === 'config');
    const subNames = config?.commands.map((c) => c.name());
    expect(subNames).toContain('validate');
    expect(subNames).toContain('schema');
    const setup = program.commands.find((c) => c.name() === 'setup');
    expect(setup?.commands.map((c) => c.name())).toContain('workspace');
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

  it('rejects an unknown profile so the run aborts with non-zero exit', async () => {
    const io = recordingIo();
    const program = buildProgram({ io, env: {}, version: 'test' });
    // Commander 12's Option.choices() violations bubble through subcommands as
    // a non-zero exit. Vitest converts the resulting `process.exit(1)` into an
    // Error containing 'process.exit'. Either path means the bad value did not
    // silently pass, which is what matters for the user-facing contract.
    await expect(() =>
      program.parseAsync(['review', '--repo', 'o/r', '--pr', '1', '--profile', 'wrong'], {
        from: 'user',
      }),
    ).rejects.toThrow(/invalid|wrong|--profile|process\.exit/i);
  });

  it('exposes a --version flag that exits 0 via exitOverride', async () => {
    const io = recordingIo();
    const program = buildProgram({ io, env: {}, version: '9.9.9' });
    // exitOverride() makes Commander throw CommanderError(code='commander.version').
    // We pin the exit code to 0 — a regression to non-zero would silently break
    // shell pipelines like `review-agent --version | tee version.txt`.
    await expect(() => program.parseAsync(['--version'], { from: 'user' })).rejects.toMatchObject({
      code: 'commander.version',
      exitCode: 0,
    });
  });
});
