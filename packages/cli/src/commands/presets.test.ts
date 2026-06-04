import { BUNDLED_PRESET_NAMES } from '@review-agent/config';
import { describe, expect, it } from 'vitest';
import { listPresetsCommand } from './presets.js';

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

describe('listPresetsCommand', () => {
  it('returns all bundled preset names', () => {
    const io = recordingIo();
    const result = listPresetsCommand(io);
    expect([...result.presets].sort()).toEqual([...BUNDLED_PRESET_NAMES].sort());
  });

  it('outputs each preset name to stdout', () => {
    const io = recordingIo();
    listPresetsCommand(io);
    const combined = io.out.join('');
    expect(combined).toContain('recommended');
    expect(combined).toContain('strict');
    expect(combined).toContain('security-focused');
  });

  it('outputs usage instructions to stdout', () => {
    const io = recordingIo();
    listPresetsCommand(io);
    const combined = io.out.join('');
    expect(combined).toContain('extends:');
  });

  it('writes nothing to stderr', () => {
    const io = recordingIo();
    listPresetsCommand(io);
    expect(io.err).toHaveLength(0);
  });
});
