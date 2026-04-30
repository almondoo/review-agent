import { spawn } from 'node:child_process';
import type { ProgramIo } from '../io.js';

export type RunEvalOpts = {
  readonly suite: string;
  readonly cwd?: string;
  readonly runner?: EvalRunner;
};

export type RunEvalResult = {
  readonly exitCode: number;
};

// Spawns the eval driver (default: `pnpm --filter @review-agent/eval test`)
// for the named suite. The CLI is intentionally a thin wrapper — the suite
// definitions live in `packages/eval/promptfooconfig.yaml`.
export type EvalRunner = (
  suite: string,
  opts: { cwd: string; stdout: (c: string) => void; stderr: (c: string) => void },
) => Promise<number>;

export async function runEvalCommand(io: ProgramIo, opts: RunEvalOpts): Promise<RunEvalResult> {
  const cwd = opts.cwd ?? process.cwd();
  const runner = opts.runner ?? defaultRunner;
  const exitCode = await runner(opts.suite, { cwd, stdout: io.stdout, stderr: io.stderr });
  if (exitCode !== 0) io.stderr(`eval suite '${opts.suite}' exited with code ${exitCode}\n`);
  return { exitCode };
}

const defaultRunner: EvalRunner = (suite, opts) =>
  new Promise<number>((resolve, reject) => {
    const child = spawn('pnpm', ['--filter', '@review-agent/eval', 'test', '--suite', suite], {
      cwd: opts.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', (b: Buffer) => opts.stdout(b.toString()));
    child.stderr?.on('data', (b: Buffer) => opts.stderr(b.toString()));
    child.on('error', (err) => reject(err));
    child.on('close', (code) => resolve(code ?? 1));
  });
