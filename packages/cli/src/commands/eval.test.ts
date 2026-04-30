import { describe, expect, it, vi } from 'vitest';
import { runEvalCommand } from './eval.js';

function recordingIo() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    stdout: (c: string) => {
      out.push(c);
    },
    stderr: (c: string) => {
      err.push(c);
    },
    exit: () => {},
  };
}

describe('runEvalCommand', () => {
  it('passes the suite name to the runner and forwards I/O', async () => {
    const io = recordingIo();
    const runner = vi.fn(async (suite: string, opts) => {
      expect(suite).toBe('golden');
      opts.stdout('eval out\n');
      opts.stderr('eval err\n');
      return 0;
    });

    const result = await runEvalCommand(io, { suite: 'golden', cwd: '/tmp', runner });
    expect(result.exitCode).toBe(0);
    expect(io.out.join('')).toContain('eval out');
    expect(io.err.join('')).toContain('eval err');
  });

  it('reports the non-zero exit code from the runner', async () => {
    const io = recordingIo();
    const runner = vi.fn(async () => 7);
    const result = await runEvalCommand(io, { suite: 'golden', cwd: '/tmp', runner });
    expect(result.exitCode).toBe(7);
    expect(io.err.join('')).toContain("'golden' exited with code 7");
  });
});
