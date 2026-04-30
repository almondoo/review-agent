import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

export type MigrateOpts = {
  readonly url: string;
  readonly migrationsFolder: string;
};

export async function runMigrations(opts: MigrateOpts): Promise<void> {
  const sql = postgres(opts.url, { max: 1 });
  try {
    const db = drizzle(sql);
    await migrate(db, { migrationsFolder: opts.migrationsFolder });
  } finally {
    await sql.end();
  }
}
