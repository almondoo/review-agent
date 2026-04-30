import * as schema from '@review-agent/core/db';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

export type DbClient = ReturnType<typeof drizzle<typeof schema>>;

export type ConnectOpts = {
  readonly url: string;
  readonly max?: number;
  readonly idleTimeout?: number;
  readonly connectTimeout?: number;
  readonly ssl?: boolean | 'require' | 'allow' | 'prefer' | 'verify-full';
};

export function createDbClient(opts: ConnectOpts): { db: DbClient; close: () => Promise<void> } {
  const pgOpts: postgres.Options<Record<string, never>> = {
    max: opts.max ?? 10,
    idle_timeout: opts.idleTimeout ?? 30,
    connect_timeout: opts.connectTimeout ?? 10,
  };
  if (opts.ssl !== undefined) pgOpts.ssl = opts.ssl;
  const sql = postgres(opts.url, pgOpts);
  const db = drizzle(sql, { schema });
  return {
    db,
    close: () => sql.end(),
  };
}
