import { repos, reviewEvalEvent } from '@review-agent/core/db';
import type { DbClient } from '@review-agent/db';
import { and, avg, count, desc, eq, gte, inArray, isNull, lt, or, sum } from 'drizzle-orm';
import { Hono } from 'hono';
import { decodeCursor, encodeCursor } from './cursor.js';
import type {
  PromptResponse,
  RepoDetail,
  RepoMetrics,
  RepoSummary,
  ReviewEvent,
} from './schemas.js';
import {
  createRepoBodySchema,
  deriveOutcome,
  patchRepoBodySchema,
  putPromptBodySchema,
  reviewsQuerySchema,
} from './schemas.js';

export type ReposDeps = {
  readonly db: DbClient;
  readonly now?: () => Date;
  readonly generateId?: () => string;
};

function defaultId(): string {
  return crypto.randomUUID();
}

function isPromptPresent(v: string | null | undefined): boolean {
  return v !== null && v !== undefined && v.trim().length > 0;
}

export function createReposRouter(deps: ReposDeps): Hono {
  const app = new Hono();
  const generateId = deps.generateId ?? defaultId;

  // GET /repos — list active repos with last-review metadata
  app.get('/', async (c) => {
    const activeRepos = await deps.db
      .select()
      .from(repos)
      .where(isNull(repos.deletedAt))
      .orderBy(repos.name);

    // Fetch the most-recent review event for every repo in a single query,
    // then pick the latest per repo in-memory. This reduces the previous
    // N+1 (one query per repo) to exactly 2 queries regardless of repo count.
    const repoNames = activeRepos.map((r) => r.name);
    const recentEvents =
      repoNames.length > 0
        ? await deps.db
            .select({
              repo: reviewEvalEvent.repo,
              createdAt: reviewEvalEvent.createdAt,
              abortReason: reviewEvalEvent.abortReason,
            })
            .from(reviewEvalEvent)
            .where(inArray(reviewEvalEvent.repo, repoNames))
            .orderBy(desc(reviewEvalEvent.createdAt))
        : [];

    // Index the latest event per repo name (first occurrence is the latest
    // because of the DESC ordering applied above).
    const latestByRepo = new Map<string, { createdAt: Date; abortReason: string | null }>();
    for (const ev of recentEvents) {
      if (!latestByRepo.has(ev.repo)) {
        latestByRepo.set(ev.repo, { createdAt: ev.createdAt, abortReason: ev.abortReason });
      }
    }

    const summaries: RepoSummary[] = activeRepos.map((r) => {
      const last = latestByRepo.get(r.name);
      return {
        id: r.id,
        platform: r.platform,
        name: r.name,
        enabled: r.enabled,
        lastReviewAt: last?.createdAt?.toISOString() ?? null,
        lastOutcome: last !== undefined ? deriveOutcome(last.abortReason ?? null) : null,
      };
    });

    return c.json(summaries, 200);
  });

  // GET /repos/:id — single repo detail
  app.get('/:id', async (c) => {
    const id = c.req.param('id');
    const rows = await deps.db
      .select()
      .from(repos)
      .where(and(eq(repos.id, id), isNull(repos.deletedAt)))
      .limit(1);

    const row = rows[0];
    if (row === undefined) {
      return c.json({ error: 'not_found' }, 404);
    }

    // Fetch last review event
    const lastEvents = await deps.db
      .select({
        createdAt: reviewEvalEvent.createdAt,
        abortReason: reviewEvalEvent.abortReason,
      })
      .from(reviewEvalEvent)
      .where(eq(reviewEvalEvent.repo, row.name))
      .orderBy(desc(reviewEvalEvent.createdAt))
      .limit(1);
    const last = lastEvents[0];

    const detail: RepoDetail = {
      id: row.id,
      platform: row.platform,
      name: row.name,
      enabled: row.enabled,
      lastReviewAt: last?.createdAt?.toISOString() ?? null,
      lastOutcome: last !== undefined ? deriveOutcome(last.abortReason ?? null) : null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      systemPromptPresent: isPromptPresent(row.systemPrompt),
    };
    return c.json(detail, 200);
  });

  // POST /repos — create a new repo entry
  app.post('/', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }

    const parsed = createRepoBodySchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'validation_error', issues: parsed.error.issues }, 422);
    }

    const { platform, name } = parsed.data;
    const now = (deps.now ?? (() => new Date()))();
    const id = generateId();

    await deps.db
      .insert(repos)
      .values({ id, platform, name, enabled: true, createdAt: now, updatedAt: now });

    const created: RepoSummary = {
      id,
      platform,
      name,
      enabled: true,
      lastReviewAt: null,
      lastOutcome: null,
    };
    return c.json(created, 201);
  });

  // PATCH /repos/:id — update enabled flag
  app.patch('/:id', async (c) => {
    const id = c.req.param('id');

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }

    const parsed = patchRepoBodySchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'validation_error', issues: parsed.error.issues }, 422);
    }

    // Nothing to update — still return the current row (idempotent)
    const existing = await deps.db
      .select()
      .from(repos)
      .where(and(eq(repos.id, id), isNull(repos.deletedAt)))
      .limit(1);

    const row = existing[0];
    if (row === undefined) {
      return c.json({ error: 'not_found' }, 404);
    }

    const { enabled } = parsed.data;
    const now = (deps.now ?? (() => new Date()))();

    if (enabled !== undefined) {
      await deps.db.update(repos).set({ enabled, updatedAt: now }).where(eq(repos.id, id));
    }

    // Re-fetch to return the current state (include deletedAt check to guard
    // against a concurrent soft-delete racing with this PATCH).
    const updated = await deps.db
      .select()
      .from(repos)
      .where(and(eq(repos.id, id), isNull(repos.deletedAt)))
      .limit(1);

    const updatedRow = updated[0];
    if (updatedRow === undefined) {
      return c.json({ error: 'not_found' }, 404);
    }

    // Fetch the most-recent review so lastReviewAt / lastOutcome are accurate.
    const lastEvents = await deps.db
      .select({
        createdAt: reviewEvalEvent.createdAt,
        abortReason: reviewEvalEvent.abortReason,
      })
      .from(reviewEvalEvent)
      .where(eq(reviewEvalEvent.repo, updatedRow.name))
      .orderBy(desc(reviewEvalEvent.createdAt))
      .limit(1);
    const last = lastEvents[0];

    const summary: RepoSummary = {
      id: updatedRow.id,
      platform: updatedRow.platform,
      name: updatedRow.name,
      enabled: updatedRow.enabled,
      lastReviewAt: last?.createdAt?.toISOString() ?? null,
      lastOutcome: last !== undefined ? deriveOutcome(last.abortReason ?? null) : null,
    };
    return c.json(summary, 200);
  });

  // DELETE /repos/:id — soft delete
  app.delete('/:id', async (c) => {
    const id = c.req.param('id');

    const existing = await deps.db
      .select({ id: repos.id })
      .from(repos)
      .where(and(eq(repos.id, id), isNull(repos.deletedAt)))
      .limit(1);

    if (existing[0] === undefined) {
      return c.json({ error: 'not_found' }, 404);
    }

    const now = (deps.now ?? (() => new Date()))();
    await deps.db.update(repos).set({ deletedAt: now, updatedAt: now }).where(eq(repos.id, id));

    return new Response(null, { status: 204 });
  });

  // GET /repos/:id/prompt — fetch system prompt
  app.get('/:id/prompt', async (c) => {
    const id = c.req.param('id');
    const rows = await deps.db
      .select({
        systemPrompt: repos.systemPrompt,
        systemPromptUpdatedAt: repos.systemPromptUpdatedAt,
      })
      .from(repos)
      .where(and(eq(repos.id, id), isNull(repos.deletedAt)))
      .limit(1);

    const row = rows[0];
    if (row === undefined) {
      return c.json({ error: 'not_found' }, 404);
    }

    const response: PromptResponse = {
      systemPrompt: row.systemPrompt ?? '',
      updatedAt: row.systemPromptUpdatedAt?.toISOString() ?? null,
    };
    return c.json(response, 200);
  });

  // PUT /repos/:id/prompt — upsert system prompt
  app.put('/:id/prompt', async (c) => {
    const id = c.req.param('id');

    // Check repo exists and is not soft-deleted first
    const existing = await deps.db
      .select({ id: repos.id })
      .from(repos)
      .where(and(eq(repos.id, id), isNull(repos.deletedAt)))
      .limit(1);

    if (existing[0] === undefined) {
      return c.json({ error: 'not_found' }, 404);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }

    const parsed = putPromptBodySchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'validation_error', issues: parsed.error.issues }, 422);
    }

    const { systemPrompt } = parsed.data;
    const now = (deps.now ?? (() => new Date()))();

    // Treat empty / whitespace-only as NULL (inherits default prompt)
    const storedPrompt = systemPrompt.trim().length > 0 ? systemPrompt : null;

    await deps.db
      .update(repos)
      .set({
        systemPrompt: storedPrompt,
        systemPromptUpdatedAt: now,
        updatedAt: now,
      })
      .where(eq(repos.id, id));

    const response: PromptResponse = {
      systemPrompt: storedPrompt ?? '',
      updatedAt: now.toISOString(),
    };
    return c.json(response, 200);
  });

  // GET /repos/:id/reviews — paginated reviews for a single repo
  app.get('/:id/reviews', async (c) => {
    const id = c.req.param('id');

    // Verify repo exists
    const repoRows = await deps.db
      .select({ name: repos.name, platform: repos.platform })
      .from(repos)
      .where(and(eq(repos.id, id), isNull(repos.deletedAt)))
      .limit(1);

    const repoRow = repoRows[0];
    if (repoRow === undefined) {
      return c.json({ error: 'not_found' }, 404);
    }

    const queryRaw = {
      limit: c.req.query('limit'),
      cursor: c.req.query('cursor'),
    };

    const parsed = reviewsQuerySchema.safeParse(queryRaw);
    if (!parsed.success) {
      return c.json({ error: 'validation_error', issues: parsed.error.issues }, 422);
    }

    const { limit, cursor } = parsed.data;

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
      .where(
        cursorDate !== undefined && cursorId !== undefined
          ? and(
              eq(reviewEvalEvent.repo, repoRow.name),
              // Tie-break: when multiple rows share the same createdAt at the
              // cursor boundary, include only those with id < cursorId to
              // prevent duplicate or skipped items across pages.
              or(
                lt(reviewEvalEvent.createdAt, cursorDate),
                and(eq(reviewEvalEvent.createdAt, cursorDate), lt(reviewEvalEvent.id, cursorId)),
              ),
            )
          : eq(reviewEvalEvent.repo, repoRow.name),
      )
      .orderBy(desc(reviewEvalEvent.createdAt), desc(reviewEvalEvent.id))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;

    const items: ReviewEvent[] = pageRows.map((row) => {
      const outcome: ReviewEvent['outcome'] = deriveOutcome(row.abortReason);
      return {
        id: row.id.toString(),
        repoId: id,
        repoName: row.repo,
        platform: repoRow.platform,
        pr: { number: row.prNumber, title: row.jobId },
        outcome,
        costUsd: row.costUsd,
        durationMs: row.latencyMs,
        createdAt: row.createdAt.toISOString(),
      };
    });

    const lastRow = pageRows[pageRows.length - 1];
    const nextCursor =
      hasMore && lastRow !== undefined ? encodeCursor(lastRow.createdAt, lastRow.id) : null;

    return c.json({ items, nextCursor }, 200);
  });

  // GET /repos/:id/metrics
  app.get('/:id/metrics', async (c) => {
    const id = c.req.param('id');
    const now = (deps.now ?? (() => new Date()))();

    // Verify repo exists
    const repoRows = await deps.db
      .select({ name: repos.name })
      .from(repos)
      .where(and(eq(repos.id, id), isNull(repos.deletedAt)))
      .limit(1);

    const repoRow = repoRows[0];
    if (repoRow === undefined) {
      return c.json({ error: 'not_found' }, 404);
    }

    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    // Aggregate stats from review_eval_event
    const allTimeRows = await deps.db
      .select({
        totalReviews: count(),
        avgDurationMs: avg(reviewEvalEvent.latencyMs),
        totalCostUsd: sum(reviewEvalEvent.costUsd),
      })
      .from(reviewEvalEvent)
      .where(eq(reviewEvalEvent.repo, repoRow.name));

    const last30dRows = await deps.db
      .select({ reviewsLast30d: count() })
      .from(reviewEvalEvent)
      .where(
        and(eq(reviewEvalEvent.repo, repoRow.name), gte(reviewEvalEvent.createdAt, thirtyDaysAgo)),
      );

    const agg = allTimeRows[0];
    const last30d = last30dRows[0];

    const metrics: RepoMetrics = {
      totalReviews: Number(agg?.totalReviews ?? 0),
      reviewsLast30d: Number(last30d?.reviewsLast30d ?? 0),
      avgDurationMs:
        agg?.avgDurationMs !== null && agg?.avgDurationMs !== undefined
          ? Math.round(Number(agg.avgDurationMs))
          : 0,
      totalCostUsd:
        agg?.totalCostUsd !== null && agg?.totalCostUsd !== undefined
          ? Number(agg.totalCostUsd)
          : 0,
    };
    return c.json(metrics, 200);
  });

  return app;
}
