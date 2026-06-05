/**
 * Minimal child-process spawn helper used by the local-review diff
 * acquisition paths (`git diff HEAD`, `git diff <range>`).
 *
 * Abstracted behind a `SpawnResult` type so tests can inject a mock
 * without touching the real child_process module.
 */

import { spawn } from 'node:child_process';

export type SpawnResult = {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
};

/**
 * Spawn a command with the given args in `cwd` and collect stdout/stderr.
 * Resolves (never rejects) — callers check `result.ok` (exitCode === 0).
 */
/* v8 ignore start */
export function spawnCommand(
  cmd: string,
  args: ReadonlyArray<string>,
  cwd: string,
): Promise<SpawnResult> {
  return new Promise<SpawnResult>((resolve) => {
    const child = spawn(cmd, [...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('close', (code) => {
      resolve({ ok: code === 0, stdout, stderr, exitCode: code });
    });
    child.on('error', (err) => {
      resolve({ ok: false, stdout: '', stderr: err.message, exitCode: null });
    });
  });
}
/* v8 ignore stop */
