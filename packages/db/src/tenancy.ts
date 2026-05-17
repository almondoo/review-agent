import { sql } from 'drizzle-orm';
import type { DbClient } from './connection.js';

// `app.current_tenant` is the GUC the RLS policies on every tenant-scoped
// table consult. Setting it scopes every read/write inside the surrounding
// transaction to the matching `installation_id`. Keep this constant in sync
// with the `tenant_isolation` policies in `packages/core/src/db/schema/*`.
export const TENANT_GUC = 'app.current_tenant';

export type TenantTransaction = Parameters<Parameters<DbClient['transaction']>[0]>[0];

// Opens a transaction, sets `app.current_tenant` for its lifetime via
// `set_config(name, value, is_local=true)`, runs `fn` against the scoped
// transaction, and commits. Throwing inside `fn` rolls back. The GUC is
// automatically discarded when the transaction ends (`is_local=true`),
// so it does not leak across the connection pool.
//
// Use this from every worker code path that touches tenant-scoped
// tables. Forgetting it does not silently leak: the policies fail-close
// on `current_setting(..., true) = NULL`, so unset = zero rows.
export async function withTenant<T>(
  db: DbClient,
  installationId: bigint | number,
  fn: (tx: TenantTransaction) => Promise<T>,
): Promise<T> {
  const id = String(installationId);
  if (!/^\d+$/.test(id)) {
    // Defence-in-depth: the value is bound as a query parameter below,
    // but we additionally reject anything that is not a positive integer
    // so a hostile caller cannot smuggle non-numeric garbage into the
    // GUC even if a future refactor regresses the parameterisation.
    throw new Error(`installationId must be a positive integer (got ${id}).`);
  }
  return db.transaction(async (tx) => {
    // Both the GUC name and value flow through Drizzle's parameter
    // binding. `SET LOCAL <name> = '<value>'` cannot be parameterised
    // by libpq (the name and value are part of the parser grammar), so
    // we go through `set_config()` — a regular function call — which
    // accepts placeholders for every argument.
    await tx.execute(sql`SELECT set_config(${TENANT_GUC}, ${id}, true)`);
    return fn(tx);
  });
}

// Reads the current tenant GUC inside a transaction — useful for
// assertions in tests or for log enrichment. Returns null when unset.
export async function readCurrentTenant(tx: TenantTransaction): Promise<string | null> {
  const rows = (await tx.execute(
    sql`SELECT current_setting(${TENANT_GUC}, true) AS tenant`,
  )) as ReadonlyArray<{ tenant: string | null }>;
  const value = rows[0]?.tenant;
  return value === undefined || value === null || value === '' ? null : value;
}
