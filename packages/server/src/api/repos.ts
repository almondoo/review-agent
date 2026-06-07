/**
 * /api/repos — repository CRUD, prompt management, review history.
 *
 * Authorization (issue #161 §F, corrected):
 *
 * Session mode (principal present):
 *   GET list / single / prompt / reviews / metrics → viewer
 *     - List filtered to repos whose installation_id is in caller's memberships
 *       OR installation_id IS NULL (manually registered repos).
 *     - Single: if repo.installationId is non-null and caller has no membership
 *       for that installation → 404 (enumeration resistance).
 *   POST (create)             → admin
 *   PATCH (enable/disable)    → admin
 *   DELETE (soft delete)      → admin
 *   PUT /:id/prompt           → editor
 *
 *   Role resolution per operation:
 *     - repo.installationId non-null  → getMembership for that installation.
 *       No membership → 404. Role insufficient → 403.
 *     - repo.installationId null      → derive maxRole from
 *       getMembershipsByPrincipal. No memberships at all → 403 for mutations,
 *       200 (visible) for GET. maxRole < required → 403.
 *
 * Legacy mode (no principal):
 *   ALL routes pass through unchanged — no filtering, no role check.
 *   This is the single-operator trust model and must remain 100% unbroken.
 */
import { type DashboardRole, roleSatisfies } from '@review-agent/core';
import { repos, reviewEvalEvent } from '@review-agent/core/db';
import type { AuditAppender, DbClient } from '@review-agent/db';
import { withTenant } from '@review-agent/db';
import { and, avg, count, desc, eq, gte, inArray, isNull, lt, or, sum } from 'drizzle-orm';
import { Hono } from 'hono';
import { getMembershipsByPrincipal, type MembershipEntry } from '../auth/principal-store.js';
import type { AuthEnv } from '../auth/types.js';
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
  readonly auditAppender?: AuditAppender;
};

function defaultId(): string {
  return crypto.randomUUID();
}

function isPromptPresent(v: string | null | undefined): boolean {
  return v !== null && v !== undefined && v.trim().length > 0;
}

// ---------------------------------------------------------------------------
// Membership helpers (used only in session mode; never called in legacy path)
// ---------------------------------------------------------------------------

/** ROLE_RANK mirrors dashboard-roles.ts — duplicated here to stay zero-import from core logic. */
const ROLE_RANK: Record<DashboardRole, number> = { viewer: 0, editor: 1, admin: 2 };

/** Derive the highest role across all memberships. Returns null when there are none. */
function maxRole(memberships: ReadonlyArray<MembershipEntry>): DashboardRole | null {
  let best: DashboardRole | null = null;
  for (const m of memberships) {
    if (best === null || ROLE_RANK[m.role] > ROLE_RANK[best]) {
      best = m.role;
    }
  }
  return best;
}

/** Build a Set of installationId strings the caller is a member of. */
function memberInstallationSet(memberships: ReadonlyArray<MembershipEntry>): Set<string> {
  return new Set(memberships.map((m) => m.installationId));
}

/**
 * Resolve authorization for a per-repo operation given the repo's installationId.
 *
 * Returns:
 *   { ok: true }              — caller is authorized
 *   { ok: false, status: 404 } — no membership for the installation (enumeration resistance)
 *   { ok: false, status: 403 } — membership exists but role is insufficient
 *
 * repoInstallationId: the repo's installation_id (bigint or null).
 * memberships: all memberships for the caller.
 * required: minimum required DashboardRole.
 */
function checkRepoAccess(
  repoInstallationId: bigint | null,
  memberships: ReadonlyArray<MembershipEntry>,
  required: DashboardRole,
): { ok: true } | { ok: false; status: 403 | 404 } {
  if (repoInstallationId !== null) {
    // Repo belongs to a specific installation — find the caller's membership.
    const idStr = String(repoInstallationId);
    const m = memberships.find((x) => x.installationId === idStr);
    if (m === undefined) {
      return { ok: false, status: 404 }; // no membership = caller cannot see this repo
    }
    if (!roleSatisfies(m.role, required)) {
      return { ok: false, status: 403 };
    }
    return { ok: true };
  }

  // Repo has no installation (manually registered).
  // Use the caller's highest role across all memberships.
  const mx = maxRole(memberships);
  if (mx === null) {
    // No memberships at all → cannot perform mutations; GETs are allowed (visible).
    return required === 'viewer' ? { ok: true } : { ok: false, status: 403 };
  }
  if (!roleSatisfies(mx, required)) {
    return { ok: false, status: 403 };
  }
  return { ok: true };
}

export function createReposRouter(deps: ReposDeps): Hono {
  const app = new Hono<AuthEnv>();
  const generateId = deps.generateId ?? defaultId;

  // ---------------------------------------------------------------------------
  // GET /repos — list active repos
  // ---------------------------------------------------------------------------
  app.get('/', async (c) => {
    const principal = c.get('principal');

    const allActive = await deps.db
      .select()
      .from(repos)
      .where(isNull(repos.deletedAt))
      .orderBy(repos.name);

    let filteredRepos = allActive;

    if (principal !== undefined) {
      // Session mode: filter to repos the caller can see.
      // Visible = installation_id IS NULL  OR  installation_id ∈ caller's memberships.
      const memberships = await getMembershipsByPrincipal(deps.db, principal.id);
      const memberSet = memberInstallationSet(memberships);
      filteredRepos = allActive.filter(
        (r) => r.installationId === null || memberSet.has(String(r.installationId)),
      );
    }
    // Legacy (principal === undefined): return all repos unchanged.

    // Group repos by installationId so each non-null tenant gets exactly one
    // withTenant call (mirrors the grouping pattern in overview-totals.ts).
    // Repos with null installationId contribute no events (no tenant to scope).
    const byInstallation = new Map<bigint, { names: string[] }>();
    for (const r of filteredRepos) {
      if (r.installationId != null) {
        const gid = r.installationId;
        const entry = byInstallation.get(gid);
        if (entry !== undefined) {
          entry.names.push(r.name);
        } else {
          byInstallation.set(gid, { names: [r.name] });
        }
      }
    }

    type EventRow = { repo: string; createdAt: Date; abortReason: string | null };
    const recentEvents: EventRow[] = [];

    for (const [gid, { names }] of byInstallation) {
      const groupEvents = await withTenant(deps.db, gid, async (tx) =>
        tx
          .select({
            repo: reviewEvalEvent.repo,
            createdAt: reviewEvalEvent.createdAt,
            abortReason: reviewEvalEvent.abortReason,
          })
          .from(reviewEvalEvent)
          .where(and(eq(reviewEvalEvent.installationId, gid), inArray(reviewEvalEvent.repo, names)))
          .orderBy(desc(reviewEvalEvent.createdAt)),
      );
      for (const ev of groupEvents) {
        recentEvents.push(ev);
      }
    }

    const latestByRepo = new Map<string, { createdAt: Date; abortReason: string | null }>();
    for (const ev of recentEvents) {
      if (!latestByRepo.has(ev.repo)) {
        latestByRepo.set(ev.repo, { createdAt: ev.createdAt, abortReason: ev.abortReason });
      }
    }

    const summaries: RepoSummary[] = filteredRepos.map((r) => {
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

  // ---------------------------------------------------------------------------
  // GET /repos/:id — single repo detail
  // ---------------------------------------------------------------------------
  app.get('/:id', async (c) => {
    const id = c.req.param('id');
    const principal = c.get('principal');

    const rows = await deps.db
      .select()
      .from(repos)
      .where(and(eq(repos.id, id), isNull(repos.deletedAt)))
      .limit(1);

    const row = rows[0];
    if (row === undefined) {
      return c.json({ error: 'not_found' }, 404);
    }

    if (principal !== undefined) {
      const memberships = await getMembershipsByPrincipal(deps.db, principal.id);
      const check = checkRepoAccess(row.installationId ?? null, memberships, 'viewer');
      if (!check.ok) {
        return c.json({ error: 'not_found' }, 404); // always 404 for GETs (enumeration resistance)
      }
    }

    let lastEvents: { createdAt: Date; abortReason: string | null }[] = [];
    if (row.installationId != null) {
      lastEvents = await withTenant(deps.db, row.installationId, async (tx) =>
        tx
          .select({
            createdAt: reviewEvalEvent.createdAt,
            abortReason: reviewEvalEvent.abortReason,
          })
          .from(reviewEvalEvent)
          .where(
            and(
              eq(reviewEvalEvent.installationId, row.installationId as bigint),
              eq(reviewEvalEvent.repo, row.name),
            ),
          )
          .orderBy(desc(reviewEvalEvent.createdAt))
          .limit(1),
      );
    }
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

  // ---------------------------------------------------------------------------
  // POST /repos — create a new repo entry (admin)
  // ---------------------------------------------------------------------------
  app.post('/', async (c) => {
    const principal = c.get('principal');

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

    if (principal !== undefined) {
      // Authorise against the caller's memberships. POST /repos doesn't take
      // an installationId in the body (installationId is set later via bulk-register
      // or left null for manually-created repos). Treat as null-installation repo.
      const memberships = await getMembershipsByPrincipal(deps.db, principal.id);
      const check = checkRepoAccess(null, memberships, 'admin');
      if (!check.ok) {
        return c.json({ error: check.status === 404 ? 'not_found' : 'forbidden' }, check.status);
      }
    }

    const { platform, name } = parsed.data;
    const now = (deps.now ?? (() => new Date()))();
    const id = generateId();

    await deps.db
      .insert(repos)
      .values({ id, platform, name, enabled: true, createdAt: now, updatedAt: now });

    if (deps.auditAppender !== undefined) {
      const actor = c.get('principal')?.id ?? null;
      try {
        await deps.auditAppender({
          event: 'repo.create',
          resourceType: 'repo',
          resourceId: id,
          ...(actor !== null ? { actor } : {}),
        });
      } catch (err) {
        process.stderr.write(
          `[review-agent] WARN: audit write failed for repo.create id=${id}: ${String(err)}\n`,
        );
      }
    }

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

  // ---------------------------------------------------------------------------
  // PATCH /repos/:id — update enabled flag (admin)
  // ---------------------------------------------------------------------------
  app.patch('/:id', async (c) => {
    const id = c.req.param('id');
    const principal = c.get('principal');

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

    const existing = await deps.db
      .select()
      .from(repos)
      .where(and(eq(repos.id, id), isNull(repos.deletedAt)))
      .limit(1);

    const row = existing[0];
    if (row === undefined) {
      return c.json({ error: 'not_found' }, 404);
    }

    if (principal !== undefined) {
      const memberships = await getMembershipsByPrincipal(deps.db, principal.id);
      const check = checkRepoAccess(row.installationId ?? null, memberships, 'admin');
      if (!check.ok) {
        return c.json({ error: check.status === 404 ? 'not_found' : 'forbidden' }, check.status);
      }
    }

    const { enabled } = parsed.data;
    const now = (deps.now ?? (() => new Date()))();

    if (enabled !== undefined) {
      await deps.db.update(repos).set({ enabled, updatedAt: now }).where(eq(repos.id, id));
    }

    if (deps.auditAppender !== undefined && enabled !== undefined) {
      const actor = c.get('principal')?.id ?? null;
      const eventName = enabled ? 'repo.enable' : 'repo.disable';
      const installationId = row.installationId;
      try {
        await deps.auditAppender({
          event: eventName,
          ...(installationId != null ? { installationId } : {}),
          resourceType: 'repo',
          resourceId: id,
          ...(actor !== null ? { actor } : {}),
        });
      } catch (err) {
        process.stderr.write(
          `[review-agent] WARN: audit write failed for ${eventName} id=${id}: ${String(err)}\n`,
        );
      }
    }

    const updated = await deps.db
      .select()
      .from(repos)
      .where(and(eq(repos.id, id), isNull(repos.deletedAt)))
      .limit(1);

    const updatedRow = updated[0];
    if (updatedRow === undefined) {
      return c.json({ error: 'not_found' }, 404);
    }

    let lastEvents: { createdAt: Date; abortReason: string | null }[] = [];
    if (updatedRow.installationId != null) {
      lastEvents = await withTenant(deps.db, updatedRow.installationId, async (tx) =>
        tx
          .select({
            createdAt: reviewEvalEvent.createdAt,
            abortReason: reviewEvalEvent.abortReason,
          })
          .from(reviewEvalEvent)
          .where(
            and(
              eq(reviewEvalEvent.installationId, updatedRow.installationId as bigint),
              eq(reviewEvalEvent.repo, updatedRow.name),
            ),
          )
          .orderBy(desc(reviewEvalEvent.createdAt))
          .limit(1),
      );
    }
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

  // ---------------------------------------------------------------------------
  // DELETE /repos/:id — soft delete (admin)
  // ---------------------------------------------------------------------------
  app.delete('/:id', async (c) => {
    const id = c.req.param('id');
    const principal = c.get('principal');

    const existing = await deps.db
      .select()
      .from(repos)
      .where(and(eq(repos.id, id), isNull(repos.deletedAt)))
      .limit(1);

    const row = existing[0];
    if (row === undefined) {
      return c.json({ error: 'not_found' }, 404);
    }

    if (principal !== undefined) {
      const memberships = await getMembershipsByPrincipal(deps.db, principal.id);
      const check = checkRepoAccess(row.installationId ?? null, memberships, 'admin');
      if (!check.ok) {
        return c.json({ error: check.status === 404 ? 'not_found' : 'forbidden' }, check.status);
      }
    }

    const now = (deps.now ?? (() => new Date()))();
    await deps.db.update(repos).set({ deletedAt: now, updatedAt: now }).where(eq(repos.id, id));

    if (deps.auditAppender !== undefined) {
      const actor = c.get('principal')?.id ?? null;
      const installationId = row.installationId;
      try {
        await deps.auditAppender({
          event: 'repo.delete',
          ...(installationId != null ? { installationId } : {}),
          resourceType: 'repo',
          resourceId: id,
          ...(actor !== null ? { actor } : {}),
        });
      } catch (err) {
        process.stderr.write(
          `[review-agent] WARN: audit write failed for repo.delete id=${id}: ${String(err)}\n`,
        );
      }
    }

    return new Response(null, { status: 204 });
  });

  // ---------------------------------------------------------------------------
  // GET /repos/:id/prompt — fetch system prompt (viewer)
  // ---------------------------------------------------------------------------
  app.get('/:id/prompt', async (c) => {
    const id = c.req.param('id');
    const principal = c.get('principal');

    const rows = await deps.db
      .select({
        systemPrompt: repos.systemPrompt,
        systemPromptUpdatedAt: repos.systemPromptUpdatedAt,
        installationId: repos.installationId,
      })
      .from(repos)
      .where(and(eq(repos.id, id), isNull(repos.deletedAt)))
      .limit(1);

    const row = rows[0];
    if (row === undefined) {
      return c.json({ error: 'not_found' }, 404);
    }

    if (principal !== undefined) {
      const memberships = await getMembershipsByPrincipal(deps.db, principal.id);
      const check = checkRepoAccess(row.installationId ?? null, memberships, 'viewer');
      if (!check.ok) {
        return c.json({ error: 'not_found' }, 404);
      }
    }

    const response: PromptResponse = {
      systemPrompt: row.systemPrompt ?? '',
      updatedAt: row.systemPromptUpdatedAt?.toISOString() ?? null,
    };
    return c.json(response, 200);
  });

  // ---------------------------------------------------------------------------
  // PUT /repos/:id/prompt — upsert system prompt (editor)
  // ---------------------------------------------------------------------------
  app.put('/:id/prompt', async (c) => {
    const id = c.req.param('id');
    const principal = c.get('principal');

    const existing = await deps.db
      .select({ id: repos.id, installationId: repos.installationId })
      .from(repos)
      .where(and(eq(repos.id, id), isNull(repos.deletedAt)))
      .limit(1);

    const repoRow = existing[0];
    if (repoRow === undefined) {
      return c.json({ error: 'not_found' }, 404);
    }

    if (principal !== undefined) {
      const memberships = await getMembershipsByPrincipal(deps.db, principal.id);
      const check = checkRepoAccess(repoRow.installationId ?? null, memberships, 'editor');
      if (!check.ok) {
        return c.json({ error: check.status === 404 ? 'not_found' : 'forbidden' }, check.status);
      }
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

    const storedPrompt = systemPrompt.trim().length > 0 ? systemPrompt : null;

    await deps.db
      .update(repos)
      .set({
        systemPrompt: storedPrompt,
        systemPromptUpdatedAt: now,
        updatedAt: now,
      })
      .where(eq(repos.id, id));

    if (deps.auditAppender !== undefined) {
      const actor = c.get('principal')?.id ?? null;
      const installationId = repoRow.installationId;
      try {
        await deps.auditAppender({
          event: 'prompt.update',
          ...(installationId != null ? { installationId } : {}),
          resourceType: 'repo',
          resourceId: id,
          ...(actor !== null ? { actor } : {}),
        });
      } catch (err) {
        process.stderr.write(
          `[review-agent] WARN: audit write failed for prompt.update id=${id}: ${String(err)}\n`,
        );
      }
    }

    const response: PromptResponse = {
      systemPrompt: storedPrompt ?? '',
      updatedAt: now.toISOString(),
    };
    return c.json(response, 200);
  });

  // ---------------------------------------------------------------------------
  // GET /repos/:id/reviews — paginated reviews for a single repo (viewer)
  // ---------------------------------------------------------------------------
  app.get('/:id/reviews', async (c) => {
    const id = c.req.param('id');
    const principal = c.get('principal');

    const repoRows = await deps.db
      .select({ name: repos.name, platform: repos.platform, installationId: repos.installationId })
      .from(repos)
      .where(and(eq(repos.id, id), isNull(repos.deletedAt)))
      .limit(1);

    const repoRow = repoRows[0];
    if (repoRow === undefined) {
      return c.json({ error: 'not_found' }, 404);
    }

    if (principal !== undefined) {
      const memberships = await getMembershipsByPrincipal(deps.db, principal.id);
      const check = checkRepoAccess(repoRow.installationId ?? null, memberships, 'viewer');
      if (!check.ok) {
        return c.json({ error: 'not_found' }, 404);
      }
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

    // eslint-disable-next-line prefer-const
    let rows: {
      id: bigint;
      repo: string;
      prNumber: number;
      jobId: string;
      abortReason: string | null;
      costUsd: number;
      latencyMs: number;
      createdAt: Date;
    }[] = [];
    if (repoRow.installationId != null) {
      rows = await withTenant(deps.db, repoRow.installationId, async (tx) =>
        tx
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
                  eq(reviewEvalEvent.installationId, repoRow.installationId as bigint),
                  eq(reviewEvalEvent.repo, repoRow.name),
                  or(
                    lt(reviewEvalEvent.createdAt, cursorDate),
                    and(
                      eq(reviewEvalEvent.createdAt, cursorDate),
                      lt(reviewEvalEvent.id, cursorId),
                    ),
                  ),
                )
              : and(
                  eq(reviewEvalEvent.installationId, repoRow.installationId as bigint),
                  eq(reviewEvalEvent.repo, repoRow.name),
                ),
          )
          .orderBy(desc(reviewEvalEvent.createdAt), desc(reviewEvalEvent.id))
          .limit(limit + 1),
      );
    }

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

  // ---------------------------------------------------------------------------
  // GET /repos/:id/metrics (viewer)
  // ---------------------------------------------------------------------------
  app.get('/:id/metrics', async (c) => {
    const id = c.req.param('id');
    const now = (deps.now ?? (() => new Date()))();
    const principal = c.get('principal');

    const repoRows = await deps.db
      .select({ name: repos.name, installationId: repos.installationId })
      .from(repos)
      .where(and(eq(repos.id, id), isNull(repos.deletedAt)))
      .limit(1);

    const repoRow = repoRows[0];
    if (repoRow === undefined) {
      return c.json({ error: 'not_found' }, 404);
    }

    if (principal !== undefined) {
      const memberships = await getMembershipsByPrincipal(deps.db, principal.id);
      const check = checkRepoAccess(repoRow.installationId ?? null, memberships, 'viewer');
      if (!check.ok) {
        return c.json({ error: 'not_found' }, 404);
      }
    }

    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    // `review_eval_event` is RLS-scoped by `installation_id`. Queries against
    // it without `app.current_tenant` set return zero rows under the
    // `review_agent_app` role (fail-closed policy). When the repo has a non-null
    // `installation_id` we run the aggregation inside `withTenant` so the GUC
    // is set for the transaction lifetime.
    //
    // Repos with a null `installation_id` (manually-registered repos) cannot be
    // scoped to a tenant — their review/cost data is not accessible under
    // per-installation RLS. For those repos we return 0/0/0/0 and document the
    // limitation: metrics for null-installation repos are unavailable because the
    // per-installation RLS policy has no tenant to match against.
    let agg: { totalReviews: unknown; avgDurationMs: unknown; totalCostUsd: unknown } | undefined;
    let last30dCount: unknown = 0;

    if (repoRow.installationId != null) {
      const results = await withTenant(deps.db, repoRow.installationId, async (tx) => {
        const allTimeRows = await tx
          .select({
            totalReviews: count(),
            avgDurationMs: avg(reviewEvalEvent.latencyMs),
            totalCostUsd: sum(reviewEvalEvent.costUsd),
          })
          .from(reviewEvalEvent)
          .where(
            and(
              eq(reviewEvalEvent.installationId, repoRow.installationId as bigint),
              eq(reviewEvalEvent.repo, repoRow.name),
            ),
          );

        const last30dRows = await tx
          .select({ reviewsLast30d: count() })
          .from(reviewEvalEvent)
          .where(
            and(
              eq(reviewEvalEvent.installationId, repoRow.installationId as bigint),
              eq(reviewEvalEvent.repo, repoRow.name),
              gte(reviewEvalEvent.createdAt, thirtyDaysAgo),
            ),
          );

        return { allTime: allTimeRows[0], last30d: last30dRows[0] };
      });

      agg = results.allTime;
      last30dCount = results.last30d?.reviewsLast30d ?? 0;
    }
    // else: null-installation repo — agg stays undefined, last30dCount stays 0.
    // Metrics for null-installation repos are unavailable under per-installation
    // RLS (no tenant to scope the query to). Returning zeros is the safe default.

    const metrics: RepoMetrics = {
      totalReviews: Number(agg?.totalReviews ?? 0),
      reviewsLast30d: Number(last30dCount),
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

  return app as unknown as Hono;
}
