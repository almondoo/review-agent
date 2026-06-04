/**
 * Integration tests for audit_log RLS round-trip under `review_agent_app` role.
 *
 * Skipped unless both TEST_DATABASE_URL (superuser, used to seed/clean) and
 * TEST_DATABASE_APP_URL (app role with RLS enabled) are set.
 *
 * What is proven:
 *   1. createAuditAppender with a non-null installationId writes rows that are
 *      readable by verifyAuditChainFromDb / verifyAuditChainSegmentFromDb /
 *      loadAuditLogForExport under the same installation's tenant context.
 *   2. Cross-tenant isolation: rows for installationA are not visible under
 *      installationB's GUC.
 *   3. chain verification returns `ok: true` after the appender round-trip.
 *   4. Export includes actor, resource_type, resource_id.
 *   5. Global (null installationId) events INSERT successfully (withCheck IS NULL)
 *      but are not visible under tenant-scoped SELECT (write-only limitation).
 */
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createAuditAppender, verifyAuditChainFromDb } from '../audit-log.js';
import { loadAuditLogForExport } from '../audit-retention.js';
import { createDbClient } from '../connection.js';
import { verifyAuditChainSegmentFromDb } from '../hmac-chain.js';

const superUrl = process.env.TEST_DATABASE_URL ?? '';
const appUrl = process.env.TEST_DATABASE_APP_URL ?? '';

// Use installation IDs unlikely to collide with other suites.
const INSTALL_A = 877_901n;
const INSTALL_B = 877_902n;

const fixedNow = (base: Date, offsetMs = 0) => new Date(base.getTime() + offsetMs);

describe.skipIf(!superUrl || !appUrl)('audit_log RLS round-trip (app role)', () => {
  it('appender writes under RLS and verify/export reads back correctly', async () => {
    // superuser connection: used for seeding/cleanup (bypasses RLS).
    const { db: superDb, close: closeSuperDb } = createDbClient({ url: superUrl });
    // app-role connection: subject to RLS tenant_isolation policy.
    const { db: appDb, close: closeAppDb } = createDbClient({ url: appUrl });

    try {
      // Clean slate for these test installations.
      await superDb.execute(sql`DELETE FROM audit_log WHERE installation_id = ${INSTALL_A}`);
      await superDb.execute(sql`DELETE FROM audit_log WHERE installation_id = ${INSTALL_B}`);
      // Also clean any null-installationId global events we write in this test
      // (identified by a known event name prefix so we don't clobber other tests).
      await superDb.execute(
        sql`DELETE FROM audit_log WHERE installation_id IS NULL AND event LIKE 'test.global.%'`,
      );

      const base = new Date('2026-06-01T10:00:00.000Z');
      let tick = 0;
      const clock = () => fixedNow(base, tick++ * 1000);

      const appender = createAuditAppender(appDb, clock);

      // --- Write three events for INSTALL_A --------------------------------
      await appender({
        event: 'repo.create',
        installationId: INSTALL_A,
        resourceType: 'repo',
        resourceId: 'repo-uuid-1',
        actor: 'p-admin',
      });
      await appender({
        event: 'repo.enable',
        installationId: INSTALL_A,
        resourceType: 'repo',
        resourceId: 'repo-uuid-1',
        actor: 'p-admin',
      });
      await appender({
        event: 'prompt.update',
        installationId: INSTALL_A,
        resourceType: 'repo',
        resourceId: 'repo-uuid-1',
        actor: 'p-editor',
      });

      // --- Write one event for INSTALL_B ------------------------------------
      await appender({
        event: 'repo.create',
        installationId: INSTALL_B,
        resourceType: 'repo',
        resourceId: 'repo-uuid-b',
        actor: 'p-admin-b',
      });

      // --- Write a global (null-installationId) event ----------------------
      // This tests that the withCheck IS NULL branch accepts the INSERT.
      // The event should NOT be visible under tenant-scoped SELECT.
      await appender({
        event: 'test.global.principal.create',
        // installationId intentionally absent (null)
        resourceType: 'principal',
        resourceId: 'p-global',
        actor: 'cli:admin',
      });

      // =====================================================================
      // Assertion 1: INSTALL_A chain verifies correctly.
      // =====================================================================
      const verifyA = await verifyAuditChainFromDb(appDb, { installationId: INSTALL_A });
      expect(verifyA.ok).toBe(true);
      expect(verifyA.rowsChecked).toBe(3);

      // =====================================================================
      // Assertion 2: segment verify for INSTALL_A also ok.
      // =====================================================================
      const segA = await verifyAuditChainSegmentFromDb(appDb, { installationId: INSTALL_A });
      expect(segA.ok).toBe(true);
      expect(segA.rowsChecked).toBe(3);

      // =====================================================================
      // Assertion 3: INSTALL_B has exactly 1 row and chain is valid.
      // =====================================================================
      const verifyB = await verifyAuditChainFromDb(appDb, { installationId: INSTALL_B });
      expect(verifyB.ok).toBe(true);
      expect(verifyB.rowsChecked).toBe(1);

      // =====================================================================
      // Assertion 4: cross-tenant isolation — INSTALL_A rows not visible
      // under INSTALL_B's GUC (and vice versa).
      // =====================================================================
      // After verifyB above, the GUC is set to INSTALL_B. Running
      // verifyAuditChainFromDb for INSTALL_A sets the GUC to INSTALL_A and
      // reads only INSTALL_A rows — the previously-set INSTALL_B GUC does not
      // bleed through because the GUC is re-set at the start of each call.
      //
      // Direct cross-tenant check: manually count INSTALL_A rows when GUC is
      // set to INSTALL_B. We use superDb (bypasses RLS) to verify the rows
      // exist but appDb (subject to RLS) cannot see them cross-tenant.
      const superCountA = (await superDb.execute(
        sql`SELECT COUNT(*) AS n FROM audit_log WHERE installation_id = ${INSTALL_A}`,
      )) as ReadonlyArray<{ n: string }>;
      expect(Number(superCountA[0]?.n)).toBe(3);

      // Set GUC to INSTALL_B on appDb and count INSTALL_A rows — must be 0.
      const crossTenantCount = (await appDb.execute(
        sql`SELECT set_config('app.current_tenant', ${String(INSTALL_B)}, false), COUNT(*) AS n FROM audit_log WHERE installation_id = ${INSTALL_A}`,
      )) as ReadonlyArray<{ n: string }>;
      expect(Number(crossTenantCount[0]?.n)).toBe(0);

      // =====================================================================
      // Assertion 5: export includes actor / resource_type / resource_id.
      // =====================================================================
      const exported = await loadAuditLogForExport(appDb, {
        installationId: INSTALL_A,
        since: new Date(base.getTime() - 1000),
      });
      expect(exported).toHaveLength(3);
      const createRow = exported.find((r) => r.event === 'repo.create');
      expect(createRow?.actor).toBe('p-admin');
      expect(createRow?.resourceType).toBe('repo');
      expect(createRow?.resourceId).toBe('repo-uuid-1');

      // =====================================================================
      // Assertion 6: global (null installationId) event is write-only under
      // tenant-scoped SELECT — visible via superuser, invisible via app role
      // (regardless of which GUC is set, because `using` requires a match).
      // =====================================================================
      const superGlobal = (await superDb.execute(
        sql`SELECT event FROM audit_log WHERE installation_id IS NULL AND event = 'test.global.principal.create'`,
      )) as ReadonlyArray<{ event: string }>;
      expect(superGlobal).toHaveLength(1); // row exists in the DB

      // Under any tenant GUC, `using` = installationId::text = GUC — NULL never matches.
      const appGlobal = (await appDb.execute(
        sql`SELECT set_config('app.current_tenant', ${String(INSTALL_A)}, false), COUNT(*) AS n FROM audit_log WHERE installation_id IS NULL AND event = 'test.global.principal.create'`,
      )) as ReadonlyArray<{ n: string }>;
      expect(Number(appGlobal[0]?.n)).toBe(0); // invisible under RLS
    } finally {
      // Cleanup.
      await superDb.execute(sql`DELETE FROM audit_log WHERE installation_id = ${INSTALL_A}`);
      await superDb.execute(sql`DELETE FROM audit_log WHERE installation_id = ${INSTALL_B}`);
      await superDb.execute(
        sql`DELETE FROM audit_log WHERE installation_id IS NULL AND event LIKE 'test.global.%'`,
      );
      await closeSuperDb();
      await closeAppDb();
    }
  }, 30_000);
});
