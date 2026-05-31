import { repos, reviewEvalEvent } from '@review-agent/core/db';
import type { DbClient } from '@review-agent/db';
import { and, count, desc, eq, gte, ilike, isNotNull, isNull, lt, or } from 'drizzle-orm';
import { Hono } from 'hono';
import { decodeCursor, encodeCursor, escapeLikePattern } from './cursor.js';
import type { ReviewEvent, ReviewEventDetail } from './schemas.js';
import { deriveOutcome, resolveSince, reviewsQuerySchema } from './schemas.js';

export type ReviewsDeps = {
  readonly db: DbClient;
  readonly now?: () => Date;
  /**
   * AWS region used when generating CodeCommit external URLs.
   * Falls back to `process.env.AWS_REGION ?? 'us-east-1'` when unset.
   */
  readonly awsRegion?: string;
};

function buildExternalUrl(
  platform: 'github' | 'codecommit',
  repoName: string,
  prNumber: number,
  awsRegion: string,
): string {
  if (platform === 'github') {
    return `https://github.com/${repoName}/pull/${prNumber}`;
  }
  return `https://console.aws.amazon.com/codesuite/codecommit/repositories/${repoName}/pull-requests/${prNumber}?region=${awsRegion}`;
}

export function createReviewsRouter(deps: ReviewsDeps): Hono {
  const app = new Hono();

  const awsRegion = deps.awsRegion ?? process.env.AWS_REGION ?? 'us-east-1';

  // GET /reviews — paginated list with filters
  app.get('/', async (c) => {
    const now = (deps.now ?? (() => new Date()))();

    const queryRaw = {
      limit: c.req.query('limit'),
      cursor: c.req.query('cursor'),
      platform: c.req.query('platform'),
      outcome: c.req.query('outcome'),
      repoQuery: c.req.query('repoQuery'),
      since: c.req.query('since'),
    };

    const parsed = reviewsQuerySchema.safeParse(queryRaw);
    if (!parsed.success) {
      return c.json({ error: 'validation_error', issues: parsed.error.issues }, 422);
    }

    const { limit, cursor, platform, outcome: outcomeFilter, repoQuery, since } = parsed.data;

    // Cursor parsing
    let cursorDate: Date | undefined;
    let cursorId: bigint | undefined;

    if (cursor !== undefined) {
      const decoded = decodeCursor(cursor);
      if (decoded === null) {
        return c.json({ error: 'invalid_cursor' }, 400);
      }
      const ts = new Date(decoded.t);
      if (Number.isNaN(ts.getTime())) {
        return c.json({ error: 'invalid_cursor' }, 400);
      }
      cursorDate = ts;
      cursorId = BigInt(decoded.id);
    }

    const sinceDate = since !== undefined ? resolveSince(since, now) : undefined;

    // Build WHERE predicates.
    // `platform` and `outcome` are not stored on `review_eval_event`
    // directly — platform comes from the `repos` table, outcome is
    // derived from `abort_reason` at query time.
    //
    // For simplicity at this data scale we build the predicate array
    // from available columns and apply platform / outcome filtering
    // in-memory after the SQL fetch (which already includes a repo join).
    // A full SQL approach is deferred until performance measurement
    // indicates it is needed.

    type WhereClause = Parameters<typeof and>[0];
    const predicates: WhereClause[] = [];

    if (cursorDate !== undefined && cursorId !== undefined) {
      // Tie-break: rows with the same createdAt as the cursor boundary are
      // included only when their id is strictly less than the cursor id.
      // This prevents duplicate/skipped items when multiple rows share a timestamp.
      predicates.push(
        or(
          lt(reviewEvalEvent.createdAt, cursorDate),
          and(eq(reviewEvalEvent.createdAt, cursorDate), lt(reviewEvalEvent.id, cursorId)),
        ),
      );
    }

    if (sinceDate !== undefined) {
      predicates.push(gte(reviewEvalEvent.createdAt, sinceDate));
    }

    if (repoQuery !== undefined && repoQuery.trim().length > 0) {
      predicates.push(ilike(reviewEvalEvent.repo, `%${escapeLikePattern(repoQuery.trim())}%`));
    }

    const whereClause = predicates.length > 0 ? and(...predicates) : undefined;

    // Fetch limit+1 rows to detect next page
    const rows = await deps.db
      .select({
        id: reviewEvalEvent.id,
        repo: reviewEvalEvent.repo,
        prNumber: reviewEvalEvent.prNumber,
        jobId: reviewEvalEvent.jobId,
        abortReason: reviewEvalEvent.abortReason,
        costUsd: reviewEvalEvent.costUsd,
        latencyMs: reviewEvalEvent.latencyMs,
        createdAt: reviewEvalEvent.createdAt,
      })
      .from(reviewEvalEvent)
      .where(whereClause)
      .orderBy(desc(reviewEvalEvent.createdAt), desc(reviewEvalEvent.id))
      .limit(limit + 1);

    // Resolve platform and UUID id for each distinct repo name
    const repoNames = [...new Set(rows.map((r) => r.repo))];
    const repoRows =
      repoNames.length > 0
        ? await deps.db
            .select({ id: repos.id, name: repos.name, platform: repos.platform })
            .from(repos)
            .where(isNull(repos.deletedAt))
        : [];

    const repoByName = new Map<string, { id: string; platform: 'github' | 'codecommit' }>(
      repoRows.map((r) => [r.name, { id: r.id, platform: r.platform }]),
    );

    // Derive outcome and apply in-memory filters (platform / outcome).
    // Skip orphaned events (review_eval_event rows with no matching repos entry).
    type RichRow = {
      id: bigint;
      repo: string;
      repoUuid: string;
      prNumber: number;
      jobId: string;
      abortReason: string | null;
      costUsd: number;
      latencyMs: number;
      createdAt: Date;
      resolvedPlatform: 'github' | 'codecommit';
      resolvedOutcome: ReviewEvent['outcome'];
    };

    const richRows: RichRow[] = [];
    for (const row of rows) {
      const repoEntry = repoByName.get(row.repo);
      if (repoEntry === undefined) {
        // Orphaned event: repo has been deleted or never registered — skip.
        continue;
      }
      const resolvedOutcome: ReviewEvent['outcome'] = deriveOutcome(row.abortReason);
      richRows.push({
        ...row,
        repoUuid: repoEntry.id,
        resolvedPlatform: repoEntry.platform,
        resolvedOutcome,
      });
    }

    // Apply platform filter
    const filtered: RichRow[] =
      platform !== undefined || outcomeFilter !== undefined
        ? richRows.filter((r) => {
            if (platform !== undefined && r.resolvedPlatform !== platform) return false;
            if (outcomeFilter !== undefined && r.resolvedOutcome !== outcomeFilter) return false;
            return true;
          })
        : richRows;

    const hasMore = filtered.length > limit;
    const pageRows = hasMore ? filtered.slice(0, limit) : filtered;

    // COUNT query (filtered) for `total`.
    // We apply the same `since` / `repoQuery` predicates as the main query.
    // For `outcome`, `failed` maps to `abort_reason IS NOT NULL` which is
    // expressible in SQL; other outcome values (commented/approved/
    // changes_requested) all map to `abort_reason IS NULL` and are not
    // further distinguished at the DB level.
    // Platform filtering would require a join with `repos`; that cross-table
    // count is left as a future improvement — the count remains an
    // approximation when a platform filter is active.
    const countPredicates: WhereClause[] = [];
    if (sinceDate !== undefined) {
      countPredicates.push(gte(reviewEvalEvent.createdAt, sinceDate));
    }
    if (repoQuery !== undefined && repoQuery.trim().length > 0) {
      countPredicates.push(ilike(reviewEvalEvent.repo, `%${escapeLikePattern(repoQuery.trim())}%`));
    }
    if (outcomeFilter === 'failed') {
      countPredicates.push(isNotNull(reviewEvalEvent.abortReason));
    } else if (outcomeFilter !== undefined) {
      // All non-failed outcomes map to abort_reason IS NULL in current schema.
      countPredicates.push(isNull(reviewEvalEvent.abortReason));
    }
    const countWhere = countPredicates.length > 0 ? and(...countPredicates) : undefined;

    const countRows = await deps.db
      .select({ value: count() })
      .from(reviewEvalEvent)
      .where(countWhere);
    const total = Number(countRows[0]?.value ?? 0);

    const items: ReviewEvent[] = pageRows.map((row) => ({
      id: row.id.toString(),
      repoId: row.repoUuid,
      repoName: row.repo,
      platform: row.resolvedPlatform,
      pr: { number: row.prNumber, title: row.jobId },
      outcome: row.resolvedOutcome,
      costUsd: row.costUsd,
      durationMs: row.latencyMs,
      createdAt: row.createdAt.toISOString(),
    }));

    const lastRow = pageRows[pageRows.length - 1];
    const nextCursor =
      hasMore && lastRow !== undefined ? encodeCursor(lastRow.createdAt, lastRow.id) : null;

    return c.json({ items, nextCursor, total }, 200);
  });

  // GET /reviews/:id — single review event detail
  app.get('/:id', async (c) => {
    const idParam = c.req.param('id');

    // ID stored as bigint in DB; validate it is a valid integer string
    let rowId: bigint;
    try {
      rowId = BigInt(idParam);
    } catch {
      return c.json({ error: 'not_found' }, 404);
    }

    const rows = await deps.db
      .select()
      .from(reviewEvalEvent)
      .where(eq(reviewEvalEvent.id, rowId))
      .limit(1);

    const row = rows[0];
    if (row === undefined) {
      return c.json({ error: 'not_found' }, 404);
    }

    // Resolve platform and UUID from repos table (best-effort; default github)
    const repoRows = await deps.db
      .select({
        id: repos.id,
        platform: repos.platform,
        systemPrompt: repos.systemPrompt,
      })
      .from(repos)
      .where(eq(repos.name, row.repo))
      .limit(1);

    const repoRow = repoRows[0];
    const platform = repoRow?.platform ?? 'github';
    const resolvedRepoId = repoRow?.id ?? row.repo;

    // TODO: snapshot of system_prompt at review time is tracked in a
    // separate issue. Currently returns the repo's current value.
    const systemPromptAtReview = repoRow?.systemPrompt ?? null;

    const outcome: ReviewEvent['outcome'] = deriveOutcome(row.abortReason);

    const externalUrl = buildExternalUrl(platform, row.repo, row.prNumber, awsRegion);

    const detail: ReviewEventDetail = {
      // Base ReviewEvent fields
      id: row.id.toString(),
      repoId: resolvedRepoId,
      repoName: row.repo,
      platform,
      pr: { number: row.prNumber, title: row.jobId },
      outcome,
      costUsd: row.costUsd,
      durationMs: row.latencyMs,
      createdAt: row.createdAt.toISOString(),
      // Detail fields
      // summary mirrors abortReason for failed reviews; null otherwise.
      // TODO: replace with dedicated review summary column when added to schema.
      summary: row.abortReason,
      // Comments, toolCalls: no dedicated table at this schema version
      comments: [],
      toolCalls: [],
      tokens: {
        prompt: row.tokensInput,
        completion: row.tokensOutput,
        total: row.tokensInput + row.tokensOutput,
      },
      timing: {
        queuedAt: row.createdAt.toISOString(),
        startedAt: null,
        completedAt: null,
      },
      provider: {
        name: row.provider,
        model: row.model,
      },
      systemPromptAtReview,
      externalUrl,
    };

    return c.json(detail, 200);
  });

  return app;
}
