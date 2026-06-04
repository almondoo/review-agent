import { createDbClient, type DbClient, loadActiveSuppressionRules } from '@review-agent/db';
import type { ProgramIo } from '../io.js';

/**
 * `review-agent suppression list` — #155 false-positive suppression.
 *
 * Lists all non-expired `suppression_rule` rows in `review_history` for the
 * given installation + repo. Each row is printed as a human-readable line:
 *
 *   ID  <row-id>    Fingerprint  <fp>    Created  <date>    Expires  <date>
 *
 * The `id` field is the `review_history.id` bigint; operators pass it to
 * `review-agent suppression remove --id <id>` to un-mute a specific rule.
 *
 * **180-day TTL**: suppression rules inherit the same TTL as all
 * `review_history` rows. A rule that is not explicitly removed via
 * `suppression remove` will naturally expire after 180 days. After
 * expiry the finding will reappear in the next review run and, if still
 * being rejected, a new suppression rule will be created automatically
 * once the threshold is crossed again.
 */

export type SuppressionListOpts = {
  readonly installationId: bigint;
  readonly repo: string;
  readonly env: NodeJS.ProcessEnv;
  // Test seams.
  readonly createDb?: (url: string) => { db: DbClient; close: () => Promise<void> };
  readonly loadSuppressions?: typeof loadActiveSuppressionRules;
  readonly now?: Date;
};

export type SuppressionListResult = {
  readonly status: 'ok' | 'config_error';
  readonly count: number;
};

export async function suppressionListCommand(
  io: ProgramIo,
  opts: SuppressionListOpts,
): Promise<SuppressionListResult> {
  const url = opts.env.DATABASE_URL ?? opts.env.REVIEW_AGENT_DATABASE_URL;
  if (!url && !opts.createDb) {
    io.stderr('DATABASE_URL (or REVIEW_AGENT_DATABASE_URL) is required.\n');
    return { status: 'config_error', count: 0 };
  }

  /* v8 ignore next */
  const makeDb = opts.createDb ?? ((u: string) => createDbClient({ url: u }));
  const { db, close } = makeDb(url ?? '');
  /* v8 ignore next */
  const load = opts.loadSuppressions ?? loadActiveSuppressionRules;

  try {
    const rows = await load(db, {
      installationId: opts.installationId,
      repo: opts.repo,
      ...(opts.now !== undefined ? { now: opts.now } : {}),
    });

    if (rows.length === 0) {
      io.stdout(`No active suppression rules for ${opts.repo}.\n`);
      return { status: 'ok', count: 0 };
    }

    io.stdout(
      `Active suppression rules for ${opts.repo} (${rows.length} rule${rows.length === 1 ? '' : 's'}):\n`,
    );
    for (const row of rows) {
      const fp = extractFingerprint(row.factText) ?? '(unknown)';
      io.stdout(
        `  ID ${row.id}  fingerprint: ${fp}  ` +
          `created: ${row.createdAt.toISOString()}  ` +
          `expires: ${row.expiresAt.toISOString()}\n`,
      );
    }
    io.stdout(
      '\nTo remove a rule: review-agent suppression remove --installation-id <id> --repo <repo> --rule-id <id>\n',
    );
    return { status: 'ok', count: rows.length };
  } finally {
    await close();
  }
}

/** Extract `[fp:<hex>]` from a factText string. */
function extractFingerprint(factText: string): string | null {
  const m = /^\[fp:([0-9a-f]+)\]/.exec(factText);
  return m?.[1] ?? null;
}
