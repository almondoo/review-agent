import type { JobMessage, QueueClient } from '@review-agent/core';
import { githubInstallations } from '@review-agent/core/db';
import { type DbClient, type TenantTransaction, withTenant } from '@review-agent/db';
import { eq } from 'drizzle-orm';
import type { Context } from 'hono';
import { getMetrics } from '../metrics.js';
import type { FeedbackAuthzResult, GithubAuthzInput } from '../utils/feedback-authz.js';
import {
  type FeedbackCommand,
  parseCommand,
  parseFeedbackCommand,
} from '../utils/parse-command.js';

export type WebhookHandlerDeps = {
  readonly queue: QueueClient;
  readonly now?: () => Date;
  /**
   * Optional injection point for `/feedback` permission checks. The
   * webhook handler stays stateless — when a `/feedback ...` command
   * is recognised the handler calls this function with the PR's
   * `{owner, repo, username}` and a deps-supplied octokit (operators
   * inject the installation-scoped client). When omitted the handler
   * still recognises `/feedback` but reports `outcome: 'unauthorized'`
   * because no authz wiring is provided (fail-closed).
   */
  readonly checkAuthz?: (input: Omit<GithubAuthzInput, 'octokit'>) => Promise<FeedbackAuthzResult>;
  /**
   * Postgres client for persisting `installation` lifecycle events into
   * `github_installations`. When omitted the handler falls back to the
   * existing ACK-only behaviour so existing tests that do not supply a
   * DB continue to pass without modification.
   */
  readonly db?: DbClient;
};

type EventName =
  | 'pull_request'
  | 'pull_request_review'
  | 'pull_request_review_comment'
  | 'pull_request_review_comment_reaction'
  | 'reaction'
  | 'issue_comment'
  | 'installation'
  | 'installation_repositories'
  | 'ping';

const ENQUEUE_PR_ACTIONS = new Set(['opened', 'synchronize', 'reopened', 'ready_for_review']);

type InstallationEventBody = {
  action?: string;
  installation?: {
    id?: number;
    app_id?: number;
    account?: { login?: string; type?: string };
  };
};

type PrEventBody = {
  action?: string;
  installation?: { id?: number };
  pull_request?: {
    number?: number;
    draft?: boolean;
    head?: { sha?: string };
  };
  repository?: { owner?: { login?: string }; name?: string };
};

type CommentEventBody = PrEventBody & {
  comment?: { body?: string; user?: { login?: string } };
  sender?: { login?: string };
  issue?: { pull_request?: object; number?: number };
};

export type FeedbackCommandOutcome = 'recorded' | 'unauthorized' | 'unresolved' | 'rate_limited';

export type WebhookResult =
  | { kind: 'ignored'; reason: string }
  | { kind: 'enqueued'; messageId: string }
  | { kind: 'noop'; reason: string }
  | { kind: 'installation'; action: string; installationId: number }
  | {
      kind: 'feedback';
      signal: 'thumbs_up' | 'thumbs_down' | 'dismissed';
      commentId: number | string;
    }
  | {
      kind: 'feedback_command';
      signal: 'thumbs_up' | 'thumbs_down' | 'dismissed';
      outcome: FeedbackCommandOutcome;
      fpPrefix?: string;
      prNumber: number;
    };

export async function handleWebhook(
  _c: Context,
  event: EventName,
  body: unknown,
  deps: WebhookHandlerDeps,
): Promise<WebhookResult> {
  const now = deps.now ?? (() => new Date());
  if (event === 'ping') return { kind: 'noop', reason: 'ping' };

  if (event === 'installation_repositories') {
    // Repository selection changes: no-op per spec (§8.2.2).
    return { kind: 'noop', reason: 'installation_repositories acknowledged' };
  }

  if (event === 'installation') {
    const ie = body as InstallationEventBody;
    const action = ie.action;
    // When no DB is wired (e.g. test environments without a real Postgres
    // connection), fall back to the existing ACK-only behaviour so callers
    // that do not inject `db` continue to work unchanged.
    if (!deps.db) {
      return { kind: 'noop', reason: `${action ?? 'unknown'} acknowledged` };
    }
    return handleInstallationEvent(action, ie, deps.db, now());
  }

  if (event === 'pull_request_review_comment_reaction' || event === 'reaction') {
    // v1.2 epic #83 Phase 3 (#92): explicit human feedback signals
    // on the agent's inline comments. The webhook receiver surfaces
    // the reaction kind + target comment id; the worker handler is
    // responsible for resolving the comment's fingerprint and
    // calling `createFeedbackWriter` from `@review-agent/runner`.
    // We don't enqueue here because the existing `JobMessage` flow
    // is shaped for review jobs, not feedback writes — operators
    // wire feedback via a separate code path.
    const feedback = classifyReactionPayload(body);
    if (!feedback) return { kind: 'ignored', reason: 'reaction payload not recognised' };
    return { kind: 'feedback', signal: feedback.signal, commentId: feedback.commentId };
  }

  if (event === 'pull_request_review') {
    const review = body as { action?: string; review?: { id?: number; state?: string } };
    // Spec v1.2 Phase 3 (#92): a reviewer dismissing the agent's
    // review is the strongest negative signal we get. Surface the
    // event so the worker can call createFeedbackWriter with
    // kind: 'dismissed'. Other pull_request_review actions
    // (submitted, edited) are not feedback signals.
    if (review.action === 'dismissed' && typeof review.review?.id === 'number') {
      return { kind: 'feedback', signal: 'dismissed', commentId: review.review.id };
    }
    // Fall through to the comment-command parser below for non-
    // dismissed pull_request_review events.
  }

  if (event === 'pull_request') {
    const pr = body as PrEventBody;
    const action = pr.action;
    if (!action || !ENQUEUE_PR_ACTIONS.has(action)) {
      return { kind: 'ignored', reason: `pull_request action '${action ?? 'unknown'}'` };
    }
    if (pr.pull_request?.draft) {
      return { kind: 'ignored', reason: 'draft PR' };
    }
    const msg = buildJobMessage(pr, `pull_request.${action}` as JobMessage['triggeredBy'], now());
    if (!msg) return { kind: 'ignored', reason: 'missing repo/installation/pr fields' };
    const r = await deps.queue.enqueue(msg);
    return { kind: 'enqueued', messageId: r.messageId };
  }

  if (
    event === 'issue_comment' ||
    event === 'pull_request_review' ||
    event === 'pull_request_review_comment'
  ) {
    const ce = body as CommentEventBody;
    if (event === 'issue_comment' && !ce.issue?.pull_request) {
      return { kind: 'ignored', reason: 'issue comment, not PR' };
    }
    const text = ce.comment?.body ?? '';

    // v1.2 #95: recognise `/feedback ...` *before* the legacy
    // `@review-agent <cmd>` parser so the feedback path is the
    // primary surface for accept/reject/dismiss signals.
    const fb = parseFeedbackCommand(text);
    if (fb) {
      return await handleFeedbackCommand('github', fb, ce, deps);
    }

    const command = parseCommand(text);
    if (!command) return { kind: 'ignored', reason: 'no agent command' };
    if (command !== 'review') {
      // pause/resume/ignore/explain/help dispatched in v0.2 #16 worker phase.
      return { kind: 'noop', reason: `command '${command}' not yet implemented` };
    }
    const msg = buildJobMessage(ce, 'comment.command', now());
    if (!msg) return { kind: 'ignored', reason: 'missing repo/installation/pr fields' };
    const r = await deps.queue.enqueue(msg);
    return { kind: 'enqueued', messageId: r.messageId };
  }

  return { kind: 'ignored', reason: `unhandled event '${event}'` };
}

/**
 * Persists GitHub App installation lifecycle events into `github_installations`.
 *
 * - `created` / `unsuspend` → upsert all fields; `unsuspend` clears `suspended_at`
 *   by setting it to NULL via the same upsert path.
 * - `suspend` → update `suspended_at = NOW()` for the matching row.
 * - `deleted` → **physical DELETE** (choice recorded here per issue #126):
 *   physical delete keeps the table clean and avoids stale rows affecting
 *   `installationCount` queries; the spec table has no `deleted_at` column,
 *   confirming physical delete is the intended approach. Historical data is
 *   retained in `review_state` / `cost_ledger` via their own RLS-scoped tables.
 * - Any other action → no-op (ACK only, future-proof).
 *
 * Uses `withTenant(installationId, ...)` so the RLS `tenant_isolation` policy
 * on `github_installations` is satisfied for every write (§16.1).
 */
async function handleInstallationEvent(
  action: string | undefined,
  body: InstallationEventBody,
  db: DbClient,
  now: Date,
): Promise<WebhookResult> {
  const installationId = body.installation?.id;
  if (typeof installationId !== 'number') {
    return { kind: 'ignored', reason: 'installation event missing installation.id' };
  }

  if (action === 'created' || action === 'unsuspend') {
    const appId = body.installation?.app_id;
    const accountLogin = body.installation?.account?.login;
    const accountType = body.installation?.account?.type;
    if (
      typeof appId !== 'number' ||
      typeof accountLogin !== 'string' ||
      typeof accountType !== 'string'
    ) {
      return { kind: 'ignored', reason: 'installation.created/unsuspend missing required fields' };
    }
    await withTenant(db, installationId, async (tx: TenantTransaction) => {
      await tx
        .insert(githubInstallations)
        .values({
          installationId: BigInt(installationId),
          appId: BigInt(appId),
          accountLogin,
          accountType,
          setupAction: 'install',
          suspendedAt: null,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: githubInstallations.installationId,
          set: {
            appId: BigInt(appId),
            accountLogin,
            accountType,
            setupAction: 'install',
            suspendedAt: null,
            updatedAt: now,
          },
        });
    });
    return { kind: 'installation', action, installationId };
  }

  if (action === 'suspend') {
    await withTenant(db, installationId, async (tx: TenantTransaction) => {
      await tx
        .update(githubInstallations)
        .set({ suspendedAt: now, updatedAt: now })
        .where(eq(githubInstallations.installationId, BigInt(installationId)));
    });
    return { kind: 'installation', action, installationId };
  }

  if (action === 'deleted') {
    await withTenant(db, installationId, async (tx: TenantTransaction) => {
      await tx
        .delete(githubInstallations)
        .where(eq(githubInstallations.installationId, BigInt(installationId)));
    });
    return { kind: 'installation', action, installationId };
  }

  // Unknown action (e.g. future GitHub additions): ACK without DB write.
  return { kind: 'noop', reason: `installation.${action ?? 'unknown'} acknowledged` };
}

/**
 * Run a `/feedback` command through the authz guard and surface the
 * outcome for the worker layer to act on (write to `review_history`).
 *
 * The webhook receiver does not itself write to the DB — that's the
 * worker's job — so this function's job is to:
 *
 *   1. Pull the requesting user and PR number from the webhook body.
 *   2. Ask `deps.checkAuthz` whether the user can push to the repo.
 *   3. Increment `review_agent_feedback_command_total` with the
 *      correct outcome label.
 *   4. Return `{ kind: 'feedback_command', outcome, ... }` so the
 *      worker handler can run the resolver + writer (which need DB
 *      access we don't have here).
 *
 * Fingerprint resolution itself happens in the worker because it
 * requires the snapshot of `commentFingerprints` from `review_state`.
 * The receiver only forwards the optional `fpPrefix` argument; the
 * worker calls `resolveFingerprint` from `@review-agent/runner`.
 */
async function handleFeedbackCommand(
  platform: 'github',
  fb: FeedbackCommand,
  ce: CommentEventBody,
  deps: WebhookHandlerDeps,
): Promise<WebhookResult> {
  const prNumber = ce.pull_request?.number ?? ce.issue?.number;
  const owner = ce.repository?.owner?.login;
  const repo = ce.repository?.name;
  const username = ce.sender?.login ?? ce.comment?.user?.login ?? '';
  const metrics = getMetrics();

  if (typeof prNumber !== 'number' || !owner || !repo) {
    metrics.feedbackCommandTotal.add(1, {
      platform,
      kind: fb.kind,
      outcome: 'unresolved',
    });
    return {
      kind: 'feedback_command',
      signal: fb.kind,
      outcome: 'unresolved',
      ...(fb.fpPrefix !== undefined ? { fpPrefix: fb.fpPrefix } : {}),
      prNumber: typeof prNumber === 'number' ? prNumber : 0,
    };
  }

  // Authz: fail-closed when no checker is wired. Operators must
  // thread `deps.checkAuthz` in `createApp` (or the equivalent
  // Lambda worker entrypoint) — without it every `/feedback` is
  // unauthorized.
  const authz: FeedbackAuthzResult = deps.checkAuthz
    ? await deps.checkAuthz({ owner, repo, username })
    : { allowed: false, reason: 'no checkAuthz wired (fail-closed)' };

  if (!authz.allowed) {
    metrics.feedbackCommandTotal.add(1, {
      platform,
      kind: fb.kind,
      outcome: 'unauthorized',
    });
    return {
      kind: 'feedback_command',
      signal: fb.kind,
      outcome: 'unauthorized',
      ...(fb.fpPrefix !== undefined ? { fpPrefix: fb.fpPrefix } : {}),
      prNumber,
    };
  }

  // Authz passed. The worker resolves the fingerprint and calls the
  // writer; rate-limit hits surface back as a separate outcome label
  // through a different code path. The receiver-side accounting is
  // 'recorded' as the optimistic positive case (worker decrements /
  // re-labels on rate_limited / unresolved).
  metrics.feedbackCommandTotal.add(1, {
    platform,
    kind: fb.kind,
    outcome: 'recorded',
  });
  return {
    kind: 'feedback_command',
    signal: fb.kind,
    outcome: 'recorded',
    ...(fb.fpPrefix !== undefined ? { fpPrefix: fb.fpPrefix } : {}),
    prNumber,
  };
}

/**
 * Helper for the worker layer to report `unresolved` / `rate_limited`
 * outcomes once the writer phase has run. Receiver-side accounting
 * stops at `recorded` (optimistic); the worker calls this when it
 * actually attempts the write.
 *
 * Kept here so the metric naming + label set lives in exactly one
 * place. Worker handlers import this from `@review-agent/server`.
 */
export function recordFeedbackCommandOutcome(
  platform: 'github' | 'codecommit',
  kind: 'thumbs_up' | 'thumbs_down' | 'dismissed',
  outcome: FeedbackCommandOutcome,
): void {
  getMetrics().feedbackCommandTotal.add(1, { platform, kind, outcome });
}

/**
 * Translate a GitHub reaction webhook body into the
 * `{ signal, commentId }` pair the worker handler feeds into
 * `createFeedbackWriter`. GitHub emits two kinds of reaction
 * payloads we care about:
 *
 *   - `pull_request_review_comment_reaction` — reactions on inline
 *     review comments. The body carries `comment.id` + reaction
 *     `content`.
 *   - `reaction` on `pull_request_review` — reactions on the
 *     summary review body. The body carries `review.id`.
 *
 * Maps `+1` → `thumbs_up`, `-1` → `thumbs_down`. Other contents
 * (`laugh`, `confused`, `heart`, `hooray`, `rocket`, `eyes`) are
 * not treated as quality signals — they're noise per spec §7.6
 * "explicit signals only".
 */
type ReactionBody = {
  action?: string;
  comment?: { id?: number };
  review?: { id?: number };
  reaction?: { content?: string };
};
function classifyReactionPayload(
  body: unknown,
): { signal: 'thumbs_up' | 'thumbs_down'; commentId: number } | null {
  const b = body as ReactionBody;
  if (b.action !== 'created') return null;
  const content = b.reaction?.content;
  if (content !== '+1' && content !== '-1') return null;
  const commentId = b.comment?.id ?? b.review?.id;
  if (typeof commentId !== 'number') return null;
  return { signal: content === '+1' ? 'thumbs_up' : 'thumbs_down', commentId };
}

function buildJobMessage(
  body: PrEventBody | CommentEventBody,
  triggeredBy: JobMessage['triggeredBy'],
  now: Date,
): JobMessage | null {
  const installationId = body.installation?.id;
  const owner = body.repository?.owner?.login;
  const repo = body.repository?.name;
  const number = body.pull_request?.number ?? (body as CommentEventBody).issue?.number;
  if (!installationId || !owner || !repo || !number) return null;
  const headSha = body.pull_request?.head?.sha;
  return {
    jobId: `${owner}/${repo}#${number}@${now.getTime()}`,
    installationId: String(installationId),
    prRef: {
      platform: 'github',
      owner,
      repo,
      number,
      ...(headSha ? { headSha } : {}),
    },
    triggeredBy,
    enqueuedAt: now.toISOString(),
  };
}
