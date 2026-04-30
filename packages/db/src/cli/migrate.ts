import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMigrations } from '../migrate.js';

const url = process.env.DATABASE_URL;
if (!url) {
  // biome-ignore lint/suspicious/noConsole: CLI entry point; stderr is the user-facing channel.
  console.error('DATABASE_URL must be set.');
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = resolve(here, '../../../core/src/db/migrations');

await runMigrations({ url, migrationsFolder });
// biome-ignore lint/suspicious/noConsole: CLI entry point; stdout is the user-facing channel.
console.info(`Applied migrations from ${migrationsFolder}`);
