import type { JobMessage, QueueClient } from '@review-agent/core';
import type { Context } from 'hono';
import { parseCommand } from '../utils/parse-command.js';

export type WebhookHandlerDeps = {
  readonly queue: QueueClient;
  readonly now?: () => Date;
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
  comment?: { body?: string };
  issue?: { pull_request?: object; number?: number };
};

export type WebhookResult =
  | { kind: 'ignored'; reason: string }
  | { kind: 'enqueued'; messageId: string }
  | { kind: 'noop'; reason: string }
  | {
      kind: 'feedback';
      signal: 'thumbs_up' | 'thumbs_down' | 'dismissed';
      commentId: number | string;
    };

export async function handleWebhook(
  _c: Context,
  event: EventName,
  body: unknown,
  deps: WebhookHandlerDeps,
): Promise<WebhookResult> {
  const now = deps.now ?? (() => new Date());
  if (event === 'ping') return { kind: 'noop', reason: 'ping' };

  if (event === 'installation' || event === 'installation_repositories') {
    // Lifecycle events: receiver-side ack only. Worker-side handling is
    // wired in v0.2 #16 / #19 once the per-installation state lives in DB.
    return { kind: 'noop', reason: `${event} acknowledged` };
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
