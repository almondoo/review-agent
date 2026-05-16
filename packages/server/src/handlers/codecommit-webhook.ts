import type { JobMessage, QueueClient } from '@review-agent/core';
import type { Context } from 'hono';
import type { SnsMessage } from '../middleware/verify-sns-signature.js';
import { parseCommand } from '../utils/parse-command.js';

export type CodecommitWebhookDeps = {
  readonly queue: QueueClient;
  readonly now?: () => Date;
  /**
   * Override `fetch` used to confirm an SNS `SubscriptionConfirmation`
   * (`GET <SubscribeURL>`). Defaults to global `fetch`. Tests inject a
   * stub to avoid network calls.
   */
  readonly confirmFetch?: (url: string) => Promise<{ ok: boolean; status: number }>;
};

export type CodecommitWebhookResult =
  | { kind: 'subscription_confirmed' }
  | { kind: 'subscription_failed'; status: number }
  | { kind: 'enqueued'; messageId: string }
  | { kind: 'noop'; reason: string }
  | { kind: 'ignored'; reason: string };

/**
 * Shape of the CodeCommit event delivered inside the SNS envelope's
 * `Message` field. Two common deliveries are supported:
 *
 * 1. **EventBridge envelope** (recommended): `aws.codecommit` → SNS
 *    topic, with the entire EventBridge event JSON serialized into
 *    `Message`. Fields of interest live under `detail.event` and
 *    `detail.{pullRequestId, repositoryName, ...}`.
 * 2. **CodeCommit-native SNS subscription**: CodeCommit can also publish
 *    pull-request notifications directly to SNS, in which case the
 *    flat fields land at the top of `Message`. We accept both.
 */
type CodecommitEvent = {
  readonly event?: string;
  readonly pullRequestId?: string | number;
  readonly repositoryName?: string;
  readonly repositoryNames?: ReadonlyArray<string>;
  readonly sourceCommit?: string;
  readonly destinationCommit?: string;
  readonly commentId?: string;
  readonly callerUserArn?: string;
  readonly commentContent?: string;
  readonly notificationBody?: string;
};

type EventBridgeEnvelope = {
  readonly detail?: CodecommitEvent;
  readonly source?: string;
  readonly 'detail-type'?: string;
};

/**
 * Maps a CodeCommit event type to a `JobMessage.triggeredBy` value, or
 * `null` when the event does not warrant a review run. We mirror the
 * GitHub mapping: opened / synchronize / comment.command.
 */
const PR_OPEN_EVENTS = new Set<string>(['pullRequestCreated']);
const PR_SYNC_EVENTS = new Set<string>([
  'pullRequestSourceBranchUpdated',
  // CodeCommit also emits `pullRequestSourceReferenceUpdated` in some
  // SDK versions; treat it the same.
  'pullRequestSourceReferenceUpdated',
]);

/**
 * Extract the inner CodeCommit event payload from the SNS `Message`
 * string. Handles both delivery shapes (EventBridge wrapper or direct).
 * Returns `null` on parse failure.
 */
function extractCodecommitEvent(snsMessage: string): CodecommitEvent | null {
  try {
    const parsed = JSON.parse(snsMessage) as EventBridgeEnvelope & CodecommitEvent;
    if (parsed.detail && typeof parsed.detail === 'object') {
      return parsed.detail;
    }
    if (typeof parsed === 'object' && parsed !== null) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

function pickRepositoryName(ev: CodecommitEvent): string | null {
  if (ev.repositoryName && ev.repositoryName.length > 0) return ev.repositoryName;
  const first = ev.repositoryNames?.[0];
  if (first && first.length > 0) return first;
  return null;
}

function pickPrNumber(ev: CodecommitEvent): number | null {
  if (ev.pullRequestId === undefined || ev.pullRequestId === null) return null;
  const n =
    typeof ev.pullRequestId === 'number' ? ev.pullRequestId : Number.parseInt(ev.pullRequestId, 10);
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) return null;
  return n;
}

/**
 * Build the JobMessage for a CodeCommit PR.
 *
 * Note: `JobMessageSchema` in `core` currently pins
 * `prRef.platform: z.literal('github')` — widening that schema to
 * include `'codecommit'` belongs to a `core` change (out of scope for
 * this handler-only PR). Since the GitHub adapter only consumes
 * `platform: 'github'` jobs, the worker safely ignores any
 * `'codecommit'` jobs that reach it until the schema is widened and a
 * dispatcher routes by platform. The type assertion below is the
 * narrowest possible workaround for the schema mismatch.
 */
function buildCodecommitJobMessage(
  ev: CodecommitEvent,
  triggeredBy: JobMessage['triggeredBy'],
  now: Date,
  snsMessageId: string,
): JobMessage | null {
  const repo = pickRepositoryName(ev);
  const number = pickPrNumber(ev);
  if (!repo || !number) return null;
  const headSha = ev.sourceCommit;
  // JobMessageSchema in core currently pins `prRef.platform: z.literal('github')`.
  // Widening it to include `'codecommit'` is a separate core change; until then
  // we mint the codecommit value here via an `unknown` round-trip so the
  // receiver is ready as soon as the schema lifts, and no `any` is introduced.
  const prRef = {
    platform: 'codecommit',
    owner: '',
    repo,
    number,
    ...(headSha ? { headSha } : {}),
  } as unknown as JobMessage['prRef'];
  const msg: JobMessage = {
    jobId: `codecommit:${repo}#${number}@${now.getTime()}`,
    installationId: snsMessageId,
    prRef,
    triggeredBy,
    enqueuedAt: now.toISOString(),
  };
  return msg;
}

export async function handleCodecommitWebhook(
  _c: Context,
  envelope: SnsMessage,
  deps: CodecommitWebhookDeps,
): Promise<CodecommitWebhookResult> {
  const now = (deps.now ?? (() => new Date()))();

  if (envelope.Type === 'SubscriptionConfirmation' || envelope.Type === 'UnsubscribeConfirmation') {
    if (!envelope.SubscribeURL) {
      return { kind: 'ignored', reason: 'missing SubscribeURL' };
    }
    const f =
      deps.confirmFetch ??
      (async (u: string) => {
        const r = await fetch(u, { method: 'GET' });
        return { ok: r.ok, status: r.status };
      });
    const res = await f(envelope.SubscribeURL);
    if (!res.ok) {
      return { kind: 'subscription_failed', status: res.status };
    }
    return { kind: 'subscription_confirmed' };
  }

  // Notification
  if (!envelope.Message) {
    return { kind: 'ignored', reason: 'missing SNS Message' };
  }
  const ev = extractCodecommitEvent(envelope.Message);
  if (!ev || typeof ev.event !== 'string') {
    return { kind: 'ignored', reason: 'malformed codecommit event' };
  }

  if (PR_OPEN_EVENTS.has(ev.event)) {
    const msg = buildCodecommitJobMessage(ev, 'pull_request.opened', now, envelope.MessageId);
    if (!msg) return { kind: 'ignored', reason: 'missing repositoryName/pullRequestId' };
    const r = await deps.queue.enqueue(msg);
    return { kind: 'enqueued', messageId: r.messageId };
  }

  if (PR_SYNC_EVENTS.has(ev.event)) {
    const msg = buildCodecommitJobMessage(ev, 'pull_request.synchronize', now, envelope.MessageId);
    if (!msg) return { kind: 'ignored', reason: 'missing repositoryName/pullRequestId' };
    const r = await deps.queue.enqueue(msg);
    return { kind: 'enqueued', messageId: r.messageId };
  }

  if (ev.event === 'commentOnPullRequest') {
    const text = ev.commentContent ?? ev.notificationBody ?? '';
    const command = parseCommand(text);
    if (!command) return { kind: 'ignored', reason: 'no agent command' };
    if (command !== 'review') {
      return { kind: 'noop', reason: `command '${command}' not yet implemented` };
    }
    const msg = buildCodecommitJobMessage(ev, 'comment.command', now, envelope.MessageId);
    if (!msg) return { kind: 'ignored', reason: 'missing repositoryName/pullRequestId' };
    const r = await deps.queue.enqueue(msg);
    return { kind: 'enqueued', messageId: r.messageId };
  }

  return { kind: 'ignored', reason: `unhandled codecommit event '${ev.event}'` };
}
