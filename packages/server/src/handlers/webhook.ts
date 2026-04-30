import type { JobMessage, QueueClient } from '@review-agent/core';
import type { Context } from 'hono';

const COMMAND_PREFIX = '@review-agent';

export type WebhookHandlerDeps = {
  readonly queue: QueueClient;
  readonly now?: () => Date;
};

type EventName =
  | 'pull_request'
  | 'pull_request_review'
  | 'pull_request_review_comment'
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
  | { kind: 'noop'; reason: string };

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

function parseCommand(commentBody: string): string | null {
  const lower = commentBody.toLowerCase();
  const idx = lower.indexOf(COMMAND_PREFIX);
  if (idx < 0) return null;
  const after = lower.slice(idx + COMMAND_PREFIX.length).trim();
  const word = after.split(/\s+/, 1)[0];
  if (!word) return null;
  return word.replace(/[^a-z]/g, '');
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
