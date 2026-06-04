import type { JobMessage, QueueClient } from '@review-agent/core';
import { githubInstallations, reviewState } from '@review-agent/core/db';
import { type DbClient, type TenantTransaction, withTenant } from '@review-agent/db';
import { and, eq } from 'drizzle-orm';
import type { Context } from 'hono';
import { getMetrics } from '../metrics.js';
import type { FeedbackAuthzResult, GithubAuthzInput } from '../utils/feedback-authz.js';
import {
  type FeedbackCommand,
  parseCommand,
  parseFeedbackCommand,
  parseSlashCommand,
} from '../utils/parse-command.js';

export type ConversationHandlerInput = {
  readonly installationId: number;
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  /** Root comment id (the `in_reply_to_id` from the reply event). */
  readonly rootCommentId: number;
  /** The id of the reply comment that triggered this event. */
  readonly replyCommentId: number;
  /** The comment body text containing the `@review-agent` mention. */
  readonly body: string;
  /** Diff hunk the original finding is anchored to, from the event payload. */
  readonly diffHunk?: string;
  /** Login of the user who sent the reply. */
  readonly sender: string;
};

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
   * Optional handler for `@review-agent` mentions in inline reply threads
   * (#149 conversation feature). When provided, `pull_request_review_comment`
   * events that are thread replies containing `@review-agent` are routed here
   * instead of (or before) the legacy `@review-agent review` command path.
   *
   * The handler is responsible for async dispatch (e.g., enqueuing to SQS)
   * and returns a `ConversationReplyOutcome`. When absent, thread reply
   * mentions fall through to the legacy command parser (which will
   * treat `@review-agent <word>` as a command).
   */
  readonly handleConversation?: (
    input: ConversationHandlerInput,
  ) => Promise<ConversationReplyOutcome>;
  /**
   * Returns the bot's own GitHub login (e.g. `review-agent[bot]`). Used
   * by the self-reply guard to block the agent from replying to itself.
   * When absent the self-reply guard is disabled (fail-open — may produce
   * reply loops in misconfigured deployments; operators should wire this).
   */
  readonly getBotLogin?: () => Promise<string>;
  /**
   * Postgres client for persisting `installation` lifecycle events into
   * `github_installations` and for reading/writing `review_state` (pause
   * flag, debounce check). When omitted the handler falls back to the
   * existing ACK-only behaviour so existing tests that do not supply a
   * DB continue to pass without modification.
   */
  readonly db?: DbClient;
  /**
   * Optional config surface for label-based triggers and skip (#157).
   * When present, the handler consults `trigger_labels` and `skip_labels`
   * on push events. When absent, label-based trigger/skip is disabled
   * (fail-open for auto_review — pushes are still enqueued normally).
   */
  readonly triggerConfig?: {
    readonly trigger_labels: ReadonlyArray<string>;
    readonly skip_labels: ReadonlyArray<string>;
  };
  /**
   * Debounce window in milliseconds (#157 idempotency).
   *
   * If the last `review_state.updated_at` for this PR is within this
   * window, a duplicate command or push trigger is silently dropped.
   * Defaults to 30 000 ms (30 seconds) when a `db` is wired; the check
   * is skipped entirely when `db` is absent (no state to consult).
   *
   * Implementation rationale: SQS Standard queues do not natively
   * deduplicate across messages with the same JobMessage content (only
   * SQS FIFO with `MessageDeduplicationId` does). The existing
   * `webhook_deliveries` table deduplicates at the per-delivery-id level
   * (one GitHub webhook event → one enqueue), but a *human* issuing two
   * `/review` commands in quick succession generates two distinct delivery
   * IDs. Using `review_state.updated_at` as an in-process guard is the
   * minimal correct approach: it is already maintained by the worker on
   * every review run and does not require an extra DB column.
   */
  readonly debounceMs?: number;
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

// Auto-review fires on these pull_request action types.
const ENQUEUE_PR_ACTIONS = new Set(['opened', 'synchronize', 'reopened', 'ready_for_review']);

// These pull_request action types are push-triggered (not command-triggered).
// Label-based skip and [skip review] marker suppression apply only here.
const PUSH_TRIGGERED_ACTIONS = new Set(['opened', 'synchronize', 'reopened']);

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
    title?: string;
    body?: string | null;
    labels?: Array<{ name?: string }>;
  };
  repository?: { owner?: { login?: string }; name?: string };
  label?: { name?: string };
};

type CommentEventBody = PrEventBody & {
  comment?: {
    body?: string;
    user?: { login?: string };
    id?: number;
    in_reply_to_id?: number;
    diff_hunk?: string;
  };
  sender?: { login?: string };
  issue?: { pull_request?: object; number?: number };
};

export type FeedbackCommandOutcome = 'recorded' | 'unauthorized' | 'unresolved' | 'rate_limited';

/**
 * Outcome of routing a `pull_request_review_comment` reply that contains a
 * `@review-agent` mention (#149).
 *
 * The webhook handler itself does NOT execute the LLM call — it hands off to
 * `deps.handleConversation` (injected by the server layer) so the actual LLM
 * invocation can happen asynchronously (SQS / Lambda) without blocking the
 * webhook response.
 *
 * `dispatched` — the conversation handler was invoked and accepted the event.
 * `unauthorized` — the commenter lacks write permission; silently ignored.
 * `self_reply` — the sender is the bot itself; guard fired, no action.
 */
export type ConversationReplyOutcome = 'dispatched' | 'unauthorized' | 'self_reply';

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
    }
  | {
      kind: 'conversation_reply';
      outcome: ConversationReplyOutcome;
      commentId: number;
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
    if (!action) {
      return { kind: 'ignored', reason: `pull_request action '${action ?? 'unknown'}'` };
    }

    // Label-based trigger: the `labeled` action fires when a label is applied.
    // Handle this BEFORE the ENQUEUE_PR_ACTIONS guard because `labeled` is not
    // in that set (it is not an automatic trigger — only named labels are).
    if (action === 'labeled') {
      if (!deps.triggerConfig) {
        return { kind: 'ignored', reason: "pull_request action 'labeled'" };
      }
      const appliedLabel = (pr.label?.name ?? '').toLowerCase();
      const triggerLabels = deps.triggerConfig.trigger_labels.map((l) => l.toLowerCase());
      if (triggerLabels.includes(appliedLabel)) {
        const msg = buildJobMessage(pr, 'comment.command', now());
        if (!msg) return { kind: 'ignored', reason: 'missing repo/installation/pr fields' };
        const r = await deps.queue.enqueue(msg);
        return { kind: 'enqueued', messageId: r.messageId };
      }
      return { kind: 'ignored', reason: `label '${appliedLabel}' not in trigger_labels` };
    }

    if (!ENQUEUE_PR_ACTIONS.has(action)) {
      return { kind: 'ignored', reason: `pull_request action '${action}'` };
    }

    if (pr.pull_request?.draft) {
      // `ready_for_review` fires when a draft is converted; the payload's
      // `draft` field is already `false` at that point, so this guard only
      // fires for still-draft PRs (e.g. a `synchronize` on a draft). This
      // preserves the existing behaviour: drafts are skipped unless
      // `auto_review.drafts: true` is configured (v1.0 #49).
      return { kind: 'ignored', reason: 'draft PR' };
    }

    // [skip review] marker: if the PR title or body contains `[skip review]`
    // (case-insensitive), suppress auto-review for all push-triggered events
    // on this PR. Commands (`/review` etc.) are NOT affected — an explicit
    // command always overrides this marker.
    if (PUSH_TRIGGERED_ACTIONS.has(action)) {
      const title = pr.pull_request?.title ?? '';
      const prBody = pr.pull_request?.body ?? '';
      if (hasSkipMarker(title) || hasSkipMarker(prBody)) {
        return { kind: 'ignored', reason: '[skip review] marker in PR title/body' };
      }
    }

    // Label-based skip: when the PR carries any label listed in
    // `skip_labels`, suppress push-triggered auto-review. Only applies to
    // push-triggered actions (opened/synchronize/reopened), not
    // `ready_for_review` (explicit user action overrides skip_labels).
    if (PUSH_TRIGGERED_ACTIONS.has(action) && deps.triggerConfig) {
      const prLabels = (pr.pull_request?.labels ?? [])
        .map((l) => (l.name ?? '').toLowerCase())
        .filter((n) => n.length > 0);
      const skipLabels = deps.triggerConfig.skip_labels.map((l) => l.toLowerCase());
      const hasSkipLabel = skipLabels.some((sl) => prLabels.includes(sl));
      if (hasSkipLabel) {
        return { kind: 'ignored', reason: 'PR carries a skip_label' };
      }
    }

    // Pause check: if the PR has been paused via `/skip`, suppress
    // push-triggered auto-review until `/resume` clears the flag.
    // Only applies to PUSH_TRIGGERED_ACTIONS (not `ready_for_review`):
    // converting a draft to ready-for-review is an explicit user action
    // that should fire regardless of the paused state.
    // Fail-open on DB error — same policy as debounce.
    if (PUSH_TRIGGERED_ACTIONS.has(action) && deps.db) {
      const installationId = pr.installation?.id;
      const owner = pr.repository?.owner?.login;
      const repo = pr.repository?.name;
      const number = pr.pull_request?.number;
      if (typeof installationId === 'number' && owner && repo && number) {
        const prId = `${owner}/${repo}#${number}`;
        const paused = await readPausedState(deps.db, installationId, prId);
        if (paused) {
          return { kind: 'ignored', reason: 'PR is paused (skip)' };
        }
      }
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
    const commentText = ce.comment?.body ?? '';

    // #149: Inline thread reply conversation routing.
    //
    // When a `pull_request_review_comment` event is a reply
    // (`comment.in_reply_to_id` is set) and the body mentions
    // `@review-agent`, route to the conversation handler BEFORE the
    // feedback/slash/legacy command parsers. This is the primary path
    // for the conversational-reply feature. If no `handleConversation`
    // is wired, fall through to the legacy command parser so existing
    // `@review-agent review` commands in review-comment bodies still work.
    if (
      event === 'pull_request_review_comment' &&
      deps.handleConversation &&
      typeof ce.comment?.in_reply_to_id === 'number'
    ) {
      const prBody = body as {
        action?: string;
        comment?: {
          id?: number;
          in_reply_to_id?: number;
          body?: string;
          diff_hunk?: string;
        };
        sender?: { login?: string };
        installation?: { id?: number };
        repository?: { owner?: { login?: string }; name?: string };
        pull_request?: { number?: number };
      };
      // Only process `created` actions (not `edited` / `deleted`).
      if (prBody.action !== 'created') {
        return { kind: 'ignored', reason: 'pull_request_review_comment action is not created' };
      }
      const mention = (prBody.comment?.body ?? '').toLowerCase();
      if (!mention.includes('@review-agent')) {
        return { kind: 'ignored', reason: 'no @review-agent mention in reply' };
      }
      const installationId = prBody.installation?.id;
      const owner = prBody.repository?.owner?.login;
      const repo = prBody.repository?.name;
      const prNumber = prBody.pull_request?.number;
      const sender = prBody.sender?.login ?? '';
      const replyCommentId = prBody.comment?.id;
      const rootCommentId = prBody.comment?.in_reply_to_id;

      if (
        typeof installationId !== 'number' ||
        !owner ||
        !repo ||
        typeof prNumber !== 'number' ||
        typeof replyCommentId !== 'number' ||
        typeof rootCommentId !== 'number'
      ) {
        return { kind: 'ignored', reason: 'conversation reply: missing required fields' };
      }

      // Self-reply guard: never reply to our own comments.
      if (deps.getBotLogin) {
        const botLogin = await deps.getBotLogin();
        if (sender === botLogin) {
          return {
            kind: 'conversation_reply',
            outcome: 'self_reply',
            commentId: replyCommentId,
            prNumber,
          };
        }
      }

      // Authorization: reuse the same write-permission check as commands.
      const authz = await checkCommandAuthz(ce, deps);
      if (!authz.allowed) {
        return {
          kind: 'conversation_reply',
          outcome: 'unauthorized',
          commentId: replyCommentId,
          prNumber,
        };
      }

      const outcome = await deps.handleConversation({
        installationId,
        owner,
        repo,
        prNumber,
        rootCommentId,
        replyCommentId,
        body: prBody.comment?.body ?? '',
        ...(prBody.comment?.diff_hunk !== undefined ? { diffHunk: prBody.comment.diff_hunk } : {}),
        sender,
      });
      return {
        kind: 'conversation_reply',
        outcome,
        commentId: replyCommentId,
        prNumber,
      };
    }

    // v1.2 #95: recognise `/feedback ...` *before* the legacy
    // `@review-agent <cmd>` parser so the feedback path is the
    // primary surface for accept/reject/dismiss signals.
    const fb = parseFeedbackCommand(commentText);
    if (fb) {
      return await handleFeedbackCommand('github', fb, ce, deps);
    }

    // #157: slash commands (`/review`, `/skip`, `/resume`) take precedence
    // over the legacy `@review-agent` prefix so the new vocabulary is the
    // primary interface while the old one remains supported.
    const slash = parseSlashCommand(commentText);
    if (slash) {
      return await handleSlashCommand(slash, ce, deps, now());
    }

    const command = parseCommand(commentText);
    if (!command) return { kind: 'ignored', reason: 'no agent command' };
    if (command === 'review') {
      // Legacy `@review-agent review` — enqueue like a slash /review.
      // Auth-gated: only PR author and maintainers (write permission).
      const authz = await checkCommandAuthz(ce, deps);
      if (!authz.allowed) {
        // Unauthorized command — silent ignore (no reply) per design
        // decision in the dispatch prompt. Mirrors feedback-authz DoS safety.
        return { kind: 'ignored', reason: 'unauthorized command' };
      }
      const debounced = await checkDebounce(ce, deps, now());
      if (debounced) return { kind: 'ignored', reason: 'debounced: review already in flight' };
      const msg = buildJobMessage(ce, 'comment.command', now());
      if (!msg) return { kind: 'ignored', reason: 'missing repo/installation/pr fields' };
      const r = await deps.queue.enqueue(msg);
      return { kind: 'enqueued', messageId: r.messageId };
    }
    // pause/resume/ignore/explain/help not yet implemented via legacy prefix.
    return { kind: 'noop', reason: `command '${command}' not yet implemented` };
  }

  return { kind: 'ignored', reason: `unhandled event '${event}'` };
}

// ---------------------------------------------------------------------------
// #157 slash command handler
// ---------------------------------------------------------------------------

/**
 * Handle a parsed slash command (`/review`, `/skip`, `/resume`).
 *
 * Authorization policy: all commands require write-equivalent permission
 * on the repository (same gate as `/feedback`). Unauthorized issuers are
 * **silently ignored** — no reply is posted. This prevents the
 * comment-forward DoS vector (anyone spamming `/skip` triggering a reply
 * storm) and is consistent with the `feedback-authz` design decision.
 */
async function handleSlashCommand(
  slash: NonNullable<ReturnType<typeof parseSlashCommand>>,
  ce: CommentEventBody,
  deps: WebhookHandlerDeps,
  now: Date,
): Promise<WebhookResult> {
  // Authz check: fail-closed when no checker is wired. The issue body asks
  // for "PR author and org members with at least `write` permission"; the
  // existing `checkAuthz` gate already enforces exactly that via
  // `getCollaboratorPermissionLevel`.
  const authz = await checkCommandAuthz(ce, deps);
  if (!authz.allowed) {
    return { kind: 'ignored', reason: 'unauthorized command' };
  }

  if (slash.kind === 'skip') {
    // Set paused = true in review_state for this PR. Requires DB to be wired;
    // without DB the command is acknowledged but has no persistent effect.
    if (deps.db) {
      const prId = buildPrId(ce);
      const installationId = ce.installation?.id;
      if (prId && typeof installationId === 'number') {
        await withTenant(deps.db, installationId, async (tx: TenantTransaction) => {
          await tx
            .update(reviewState)
            .set({ paused: true, updatedAt: now })
            .where(
              and(
                eq(reviewState.installationId, BigInt(installationId)),
                eq(reviewState.prId, prId),
              ),
            );
        });
      }
    }
    return { kind: 'noop', reason: 'PR paused (skip)' };
  }

  if (slash.kind === 'resume') {
    // Set paused = false in review_state for this PR.
    if (deps.db) {
      const prId = buildPrId(ce);
      const installationId = ce.installation?.id;
      if (prId && typeof installationId === 'number') {
        await withTenant(deps.db, installationId, async (tx: TenantTransaction) => {
          await tx
            .update(reviewState)
            .set({ paused: false, updatedAt: now })
            .where(
              and(
                eq(reviewState.installationId, BigInt(installationId)),
                eq(reviewState.prId, prId),
              ),
            );
        });
      }
    }
    return { kind: 'noop', reason: 'PR resumed' };
  }

  // slash.kind === 'review'
  // Debounce: check whether a review was recently started for this PR.
  const debounced = await checkDebounce(ce, deps, now);
  if (debounced) return { kind: 'ignored', reason: 'debounced: review already in flight' };

  const msg = buildJobMessageWithScope(ce, 'comment.command', now, slash.pathScope);
  if (!msg) return { kind: 'ignored', reason: 'missing repo/installation/pr fields' };
  const r = await deps.queue.enqueue(msg);
  return { kind: 'enqueued', messageId: r.messageId };
}

// ---------------------------------------------------------------------------
// Auth helper for command events
// ---------------------------------------------------------------------------

/**
 * Run the command authorization check for a comment event.
 *
 * Fails closed when no `checkAuthz` is wired (same policy as feedback-authz).
 */
async function checkCommandAuthz(
  ce: CommentEventBody,
  deps: WebhookHandlerDeps,
): Promise<FeedbackAuthzResult> {
  const owner = ce.repository?.owner?.login;
  const repo = ce.repository?.name;
  const username = ce.sender?.login ?? ce.comment?.user?.login ?? '';

  if (!owner || !repo || !username) {
    return { allowed: false, reason: 'missing owner/repo/username from webhook payload' };
  }
  if (!deps.checkAuthz) {
    return { allowed: false, reason: 'no checkAuthz wired (fail-closed)' };
  }
  return deps.checkAuthz({ owner, repo, username });
}

// ---------------------------------------------------------------------------
// review_state reader — shared by pause check and debounce
// ---------------------------------------------------------------------------

type ReviewStateRow = { updatedAt: Date; paused: boolean };

/**
 * Read the current `review_state` row for a PR, scoped to the correct
 * tenant via `withTenant`. Returns `null` when the row does not exist
 * (PR has never been reviewed) or when a DB error occurs (fail-open).
 */
async function readReviewStateRow(
  db: DbClient,
  installationId: number,
  prId: string,
): Promise<ReviewStateRow | null> {
  try {
    const rows = await withTenant(db, installationId, (tx) =>
      tx
        .select({ updatedAt: reviewState.updatedAt, paused: reviewState.paused })
        .from(reviewState)
        .where(
          and(eq(reviewState.installationId, BigInt(installationId)), eq(reviewState.prId, prId)),
        )
        .limit(1),
    );
    return rows[0] ?? null;
  } catch {
    // Fail open — callers treat null as "no state known".
    return null;
  }
}

/**
 * Returns `true` when the PR's `review_state.paused` flag is set.
 * Fail-open: returns `false` when the row is absent or DB errors.
 */
async function readPausedState(
  db: DbClient,
  installationId: number,
  prId: string,
): Promise<boolean> {
  const row = await readReviewStateRow(db, installationId, prId);
  return row?.paused ?? false;
}

// ---------------------------------------------------------------------------
// Debounce helper
// ---------------------------------------------------------------------------

const DEFAULT_DEBOUNCE_MS = 30_000;

/**
 * Returns `true` when a review for this PR was last updated within the
 * debounce window, indicating a run is likely still in flight.
 *
 * Without a DB the check always returns `false` (no debounce). This is
 * intentional: the caller cannot know in-flight state and must rely on
 * downstream SQS idempotency or job dedup instead.
 */
async function checkDebounce(
  ce: CommentEventBody,
  deps: WebhookHandlerDeps,
  now: Date,
): Promise<boolean> {
  if (!deps.db) return false;
  const installationId = ce.installation?.id;
  const prId = buildPrId(ce);
  if (typeof installationId !== 'number' || !prId) return false;

  const windowMs = deps.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const row = await readReviewStateRow(deps.db, installationId, prId);
  if (!row) return false;
  const age = now.getTime() - row.updatedAt.getTime();
  return age < windowMs;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a canonical PR id string from an event body. */
function buildPrId(ce: CommentEventBody): string | null {
  const owner = ce.repository?.owner?.login;
  const repo = ce.repository?.name;
  const number = ce.pull_request?.number ?? ce.issue?.number;
  if (!owner || !repo || !number) return null;
  return `${owner}/${repo}#${number}`;
}

/**
 * Returns `true` when `text` contains the `[skip review]` marker
 * (case-insensitive). Only the exact phrase inside brackets is matched;
 * surrounding content is ignored.
 */
function hasSkipMarker(text: string): boolean {
  return /\[skip review\]/i.test(text);
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
  return buildJobMessageWithScope(body, triggeredBy, now, undefined);
}

function buildJobMessageWithScope(
  body: PrEventBody | CommentEventBody,
  triggeredBy: JobMessage['triggeredBy'],
  now: Date,
  pathScope: string | undefined,
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
    ...(pathScope !== undefined ? { pathScope: [pathScope] } : {}),
  };
}
