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
  /**
   * Allowlist of SNS Topic ARNs accepted by this receiver (SEC-1).
   *
   * The SNS message signature only proves "some AWS SNS topic in some
   * account signed this envelope". Without a topic-level allowlist an
   * attacker who owns an SNS topic in any AWS account could deliver
   * a `SubscriptionConfirmation` to our endpoint, watch us confirm,
   * and then deliver forged `commentOnPullRequest` notifications that
   * pass signature verification.
   *
   * The receiver is fail-closed: an unset or empty allowlist rejects
   * every delivery with `kind: 'forbidden'`. Operators must opt in
   * explicitly via the `REVIEW_AGENT_SNS_TOPIC_ARNS` env (see
   * `docs/deployment/aws.md`).
   */
  readonly allowedTopicArns?: ReadonlyArray<string>;
};

export type CodecommitWebhookResult =
  | { kind: 'subscription_confirmed' }
  | { kind: 'subscription_failed'; status: number }
  | { kind: 'enqueued'; messageId: string }
  | { kind: 'noop'; reason: string }
  | { kind: 'ignored'; reason: string }
  | { kind: 'forbidden'; reason: string };

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
  readonly account?: string;
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
 * Extract the inner CodeCommit event payload + (when present) the
 * EventBridge envelope's `account` field. The envelope's `account` is
 * a 12-digit AWS account ID; we use it as a stable `installationId`
 * (FUNC C-1 audit fix). Returns both pieces in one parse pass.
 */
function extractCodecommitEvent(
  snsMessage: string,
): { readonly event: CodecommitEvent; readonly account: string | null } | null {
  try {
    const parsed = JSON.parse(snsMessage) as EventBridgeEnvelope & CodecommitEvent;
    if (parsed.detail && typeof parsed.detail === 'object') {
      const account = typeof parsed.account === 'string' ? parsed.account : null;
      return { event: parsed.detail, account };
    }
    if (typeof parsed === 'object' && parsed !== null) {
      return { event: parsed, account: null };
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
  // FUNC M-1: reject unsafe integers (>2^53). `Number.isSafeInteger`
  // is the right guard — `Number.isInteger` accepts values that lose
  // precision when round-tripped through `String()`.
  if (!Number.isSafeInteger(n) || n <= 0) return null;
  return n;
}

/**
 * Build the JobMessage for a CodeCommit PR.
 *
 * `installationId` is the EventBridge envelope's `account` field (a
 * 12-digit AWS account ID). FUNC C-1 audit fix:
 *
 * - Stable across deliveries (was previously the per-delivery SNS
 *   MessageId, which broke incremental-review keying).
 * - Numeric, so it passes `withTenant`'s `/^\d+$/` guard in
 *   `packages/db/src/tenancy.ts:27`.
 * - Fits in the `bigint` columns the schema uses for installation_id.
 *
 * Multiple repositories in the same account share the installationId;
 * per-PR keying via `review_state.id = ${owner}/${repo}#${number}`
 * continues to differentiate them.
 */
function buildCodecommitJobMessage(
  ev: CodecommitEvent,
  triggeredBy: JobMessage['triggeredBy'],
  now: Date,
  installationId: string,
): JobMessage | null {
  const repo = pickRepositoryName(ev);
  const number = pickPrNumber(ev);
  if (!repo || !number) return null;
  const headSha = ev.sourceCommit;
  const prRef: JobMessage['prRef'] = {
    platform: 'codecommit',
    owner: '',
    repo,
    number,
    ...(headSha ? { headSha } : {}),
  };
  const msg: JobMessage = {
    jobId: `codecommit:${repo}#${number}@${now.getTime()}`,
    installationId,
    prRef,
    triggeredBy,
    enqueuedAt: now.toISOString(),
  };
  return msg;
}

/**
 * SEC-1: validate the envelope's `TopicArn` against the allowlist.
 *
 * Fail-closed: empty/missing allowlist rejects everything. The operator
 * must set `REVIEW_AGENT_SNS_TOPIC_ARNS` (or pass `allowedTopicArns`
 * in tests) explicitly.
 */
function isAllowedTopic(envelope: SnsMessage, allowlist: ReadonlyArray<string>): boolean {
  if (allowlist.length === 0) return false;
  return allowlist.includes(envelope.TopicArn);
}

export async function handleCodecommitWebhook(
  _c: Context,
  envelope: SnsMessage,
  deps: CodecommitWebhookDeps,
): Promise<CodecommitWebhookResult> {
  const now = (deps.now ?? (() => new Date()))();
  const allowlist = deps.allowedTopicArns ?? [];

  // SEC-1: gate every delivery — including SubscriptionConfirmation —
  // on the TopicArn allowlist before doing anything else.
  if (!isAllowedTopic(envelope, allowlist)) {
    return {
      kind: 'forbidden',
      reason:
        allowlist.length === 0
          ? 'REVIEW_AGENT_SNS_TOPIC_ARNS is unset; the receiver is fail-closed by design'
          : `TopicArn '${envelope.TopicArn}' is not in the configured allowlist`,
    };
  }

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
  const extracted = extractCodecommitEvent(envelope.Message);
  if (!extracted) {
    return { kind: 'ignored', reason: 'malformed codecommit event' };
  }
  const ev = extracted.event;
  if (typeof ev.event !== 'string') {
    return { kind: 'ignored', reason: 'malformed codecommit event' };
  }

  // FUNC C-1: require a numeric AWS account ID to use as installationId.
  // CodeCommit-native (flat) deliveries do not include `account`; the
  // receiver requires the EventBridge wrapper for tenancy enforcement.
  const installationId = extracted.account ?? null;
  if (installationId === null || !/^\d+$/.test(installationId)) {
    return {
      kind: 'ignored',
      reason: 'missing or non-numeric EventBridge account (required for installationId)',
    };
  }

  if (PR_OPEN_EVENTS.has(ev.event)) {
    const msg = buildCodecommitJobMessage(ev, 'pull_request.opened', now, installationId);
    if (!msg) return { kind: 'ignored', reason: 'missing repositoryName/pullRequestId' };
    const r = await deps.queue.enqueue(msg);
    return { kind: 'enqueued', messageId: r.messageId };
  }

  if (PR_SYNC_EVENTS.has(ev.event)) {
    const msg = buildCodecommitJobMessage(ev, 'pull_request.synchronize', now, installationId);
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
    const msg = buildCodecommitJobMessage(ev, 'comment.command', now, installationId);
    if (!msg) return { kind: 'ignored', reason: 'missing repositoryName/pullRequestId' };
    const r = await deps.queue.enqueue(msg);
    return { kind: 'enqueued', messageId: r.messageId };
  }

  return { kind: 'ignored', reason: `unhandled codecommit event '${ev.event}'` };
}
