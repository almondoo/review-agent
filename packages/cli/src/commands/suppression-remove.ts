import { createDbClient, type DbClient, deleteSuppressionRule } from '@review-agent/db';
import type { ProgramIo } from '../io.js';

/**
 * `review-agent suppression remove` — #155 false-positive suppression.
 *
 * Removes a single `suppression_rule` row from `review_history` by its
 * `review_history.id` (surfaced by `review-agent suppression list`). The
 * delete is scoped to the given `installationId` + `repo` + `fact_type =
 * 'suppression_rule'` triple so a mistyped `--rule-id` can never remove
 * a row from another tenant or a different fact type.
 *
 * After removal, the next review run for the same PR will re-emit findings
 * that match the removed fingerprint. If the user continues to reject them,
 * the suppression rule will be re-created automatically once the threshold
 * is crossed again.
 *
 * **Idempotent**: re-running with the same `--rule-id` after the rule has
 * already been removed (or after it has expired) returns `not_found` but
 * does NOT exit non-zero — this matches the intent that removing a non-
 * existent suppression is a no-op.
 */

export type SuppressionRemoveOpts = {
  readonly installationId: bigint;
  readonly repo: string;
  /** `review_history.id` of the suppression rule to remove. */
  readonly ruleId: bigint;
  readonly env: NodeJS.ProcessEnv;
  // Test seams.
  readonly createDb?: (url: string) => { db: DbClient; close: () => Promise<void> };
  readonly deleteRule?: typeof deleteSuppressionRule;
};

export type SuppressionRemoveResult = {
  readonly status: 'ok' | 'not_found' | 'config_error';
};

export async function suppressionRemoveCommand(
  io: ProgramIo,
  opts: SuppressionRemoveOpts,
): Promise<SuppressionRemoveResult> {
  const url = opts.env.DATABASE_URL ?? opts.env.REVIEW_AGENT_DATABASE_URL;
  if (!url && !opts.createDb) {
    io.stderr('DATABASE_URL (or REVIEW_AGENT_DATABASE_URL) is required.\n');
    return { status: 'config_error' };
  }

  /* v8 ignore next */
  const makeDb = opts.createDb ?? ((u: string) => createDbClient({ url: u }));
  const { db, close } = makeDb(url ?? '');
  /* v8 ignore next */
  const del = opts.deleteRule ?? deleteSuppressionRule;

  try {
    const deleted = await del(db, {
      id: opts.ruleId,
      installationId: opts.installationId,
      repo: opts.repo,
    });

    if (deleted) {
      io.stdout(
        `Suppression rule ${opts.ruleId} removed from ${opts.repo}. ` +
          'The finding will reappear on the next review run.\n',
      );
      return { status: 'ok' };
    }

    io.stdout(
      `Suppression rule ${opts.ruleId} was not found for ${opts.repo} ` +
        '(may have already been removed or expired).\n',
    );
    return { status: 'not_found' };
  } finally {
    await close();
  }
}
