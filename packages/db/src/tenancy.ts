import { sql } from 'drizzle-orm';
import type { DbClient } from './connection.js';

// `app.current_tenant` is the GUC the RLS policies on every tenant-scoped
// table consult. Setting it scopes every read/write inside the surrounding
// transaction to the matching `installation_id`. Keep this constant in sync
// with the `tenant_isolation` policies in `packages/core/src/db/schema/*`.
export const TENANT_GUC = 'app.current_tenant';

export type TenantTransaction = Parameters<Parameters<DbClient['transaction']>[0]>[0];

// Opens a transaction, sets `app.current_tenant` for its lifetime via
// `SET LOCAL`, runs `fn` against the scoped transaction, and commits.
// Throwing inside `fn` rolls back. The GUC is automatically discarded
// when the transaction ends — `SET LOCAL` does not leak across the
// connection pool.
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
    // Defence-in-depth: the GUC is interpolated into a SET LOCAL
    // statement. We accept only digit strings so a hostile caller
    // cannot inject SQL via the tenant id even if RLS is bypassed by
    // a misconfigured role.
    throw new Error(`installationId must be a positive integer (got ${id}).`);
  }
  return db.transaction(async (tx) => {
    await tx.execute(sql.raw(`SET LOCAL ${TENANT_GUC} = '${id}';`));
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
