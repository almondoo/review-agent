#!/usr/bin/env node
import { CommanderError } from 'commander';
import { buildProgram } from './program.js';

async function main(): Promise<void> {
  const program = buildProgram();
  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    if (err instanceof CommanderError) {
      // Commander already printed usage/help; honour its exit code.
      process.exit(err.exitCode ?? 1);
    }
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`review-agent: ${message}\n`);
    process.exit(1);
  }
}

void main();
