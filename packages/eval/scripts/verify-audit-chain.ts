// Audit chain verifier. Run nightly against the production database to
// detect tampering. Exits 0 on intact chain, 1 on any break.
//
//   DATABASE_URL=postgres://... \
//   pnpm tsx packages/eval/scripts/verify-audit-chain.ts [installationId]
//
// Pass an optional installationId to limit verification to one tenant.

import { createDbClient, verifyAuditChainFromDb } from '@review-agent/db';

const url = process.env.DATABASE_URL;
if (!url) {
  // biome-ignore lint/suspicious/noConsole: CLI entry point.
  console.error('DATABASE_URL must be set.');
  process.exit(1);
}

const filterId = process.argv[2] ? BigInt(process.argv[2]) : undefined;
const { db, close } = createDbClient({ url });

try {
  const report = await verifyAuditChainFromDb(
    db,
    filterId !== undefined ? { installationId: filterId } : {},
  );
  if (report.ok) {
    // biome-ignore lint/suspicious/noConsole: CLI entry point.
    console.info(
      `audit_log chain intact: ${report.rowsChecked} rows${
        filterId !== undefined ? ` for installation ${filterId}` : ''
      }`,
    );
    process.exit(0);
  }
  // biome-ignore lint/suspicious/noConsole: CLI entry point.
  console.error(
    `audit_log chain broken: ${report.breaks.length} break(s) across ${report.rowsChecked} rows`,
  );
  for (const b of report.breaks) {
    // biome-ignore lint/suspicious/noConsole: CLI entry point.
    console.error(
      `  index=${b.index} ts=${b.row.ts.toISOString()} expected=${b.expected.slice(0, 12)}.. actual=${b.actual.slice(0, 12)}..`,
    );
  }
  process.exit(1);
} finally {
  await close();
}
