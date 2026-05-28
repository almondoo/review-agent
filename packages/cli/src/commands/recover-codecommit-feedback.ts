import {
  extractFingerprintFromComment,
  type FeedbackKind,
  feedbackKindToFactType,
} from '@review-agent/core';
import type { RecoverFeedbackHistoryCandidate } from '@review-agent/db';
import {
  type CodeCommitClientLike,
  type CodeCommitRawComment,
  checkCodeCommitFeedbackAuthz,
  listCodeCommitCommentsForPullRequest,
  listCodeCommitPullRequestIds,
} from '@review-agent/platform-codecommit';

/**
 * v1.2 #110 — CodeCommit `/feedback` re-scrape for disaster recovery.
 *
 * Walks every PR in the repository (status filterable), paginates the
 * comment list, finds `/feedback` commands, and resolves the targeted
 * Bot comment via `inReplyTo` → parent body → `<!-- fingerprint:<fp> -->`
 * marker (#96). The resolved fingerprints become
 * `RecoverFeedbackHistoryCandidate` rows ready for the existing
 * `recoverFeedbackHistory` helper (#105), which is idempotent against
 * existing `review_history.fact_text` so re-runs are safe.
 *
 * Open-question resolutions from #110:
 *   * Q1: default `2 req/sec` (operator-tunable via `delayMs = 500`).
 *     The walk awaits a `sleep(delayMs)` between page calls to stay
 *     under CodeCommit's unpublished throttling cap.
 *   * Q2: default = all PRs (open + closed). `--since` filters by
 *     comment creation date so the operator can scope to "since the
 *     last successful Postgres snapshot".
 *   * Q3: fingerprint resolution failure is `skip + count`; we never
 *     abort the whole run. Final stats expose `unresolved`.
 *   * Q5: only marker (a) resolution is implemented from the CLI;
 *     `<fp_prefix>` argument resolution requires a DB lookup against
 *     `review_state.commentFingerprints` and is out of scope (the
 *     webhook receiver is the right place for prefix-argument
 *     resolution — see `packages/runner/src/feedback-fingerprint-resolver.ts`).
 */
export type ScrapeCodeCommitFeedbackOpts = {
  readonly client: CodeCommitClientLike;
  readonly repositoryName: string;
  /**
   * Required. The IAM principal ARN whose parent comments are allowed
   * to carry recoverable fingerprints. `/feedback` replies whose
   * `inReplyTo` resolves to a parent authored by a different ARN are
   * skipped and counted as unresolved — prevents an attacker from
   * crafting a comment that contains a forged `<!-- fingerprint:... -->`
   * marker and laundering it into `review_history`.
   */
  readonly botArn: string;
  /**
   * v1.2 #113: operator-managed allowlist of IAM principal ARNs whose
   * `/feedback` replies are recoverable. Mirrors the runtime webhook
   * gate (`packages/server/src/handlers/codecommit-webhook.ts:347-365`)
   * so that recovery cannot silently re-promote replies that the live
   * authz check would have denied.
   *
   * Fail-closed: an empty array denies every reply (treated as
   * `unauthorized`). The CLI layer is responsible for parsing
   * `REVIEW_AGENT_FEEDBACK_ALLOWLIST` (CSV) into this array.
   */
  readonly feedbackAllowlist: ReadonlyArray<string>;
  readonly pullRequestStatus?: 'OPEN' | 'CLOSED' | 'ALL';
  readonly sinceDate?: Date;
  readonly onlyPr?: number;
  readonly delayMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
};

export type ScrapeCodeCommitFeedbackResult = {
  readonly candidates: ReadonlyArray<RecoverFeedbackHistoryCandidate>;
  readonly stats: {
    readonly prsWalked: number;
    readonly commentsSeen: number;
    readonly feedbackCommandsSeen: number;
    readonly unresolved: number;
    /**
     * v1.2 #113: `/feedback` replies whose author ARN is not on
     * `feedbackAllowlist` (or whose `authorArn` is undefined — also
     * fail-closed). Tracked separately from `unresolved` so the
     * operator can distinguish missing/malformed data from
     * security-denied attempts.
     */
    readonly unauthorized: number;
    readonly resolved: number;
  };
};

const FEEDBACK_PREFIX = '/feedback';

/**
 * Minimal inline parser matching `parseFeedbackCommand` in
 * `@review-agent/server`. Inlined so the CLI does not pull the full
 * server bundle (Hono + AWS handlers etc.) just to recognise three
 * subcommands. Kept narrow:
 *   - `/feedback accept|reject|dismiss [<fp_prefix>]`
 *   - case-insensitive on the prefix; word-boundary before the prefix
 *   - returns `null` for malformed bodies
 */
function parseFeedbackKind(commentBody: string): FeedbackKind | null {
  const lower = commentBody.toLowerCase();
  const idx = lower.indexOf(FEEDBACK_PREFIX);
  if (idx < 0) return null;
  if (idx > 0) {
    const before = lower.charCodeAt(idx - 1);
    const isWordChar =
      (before >= 0x61 && before <= 0x7a) || (before >= 0x30 && before <= 0x39) || before === 0x5f;
    if (isWordChar) return null;
  }
  const after = lower.slice(idx + FEEDBACK_PREFIX.length).trim();
  const tokens = after.split(/\s+/);
  const sub = tokens[0];
  if (sub === 'accept') return 'thumbs_up';
  if (sub === 'reject') return 'thumbs_down';
  if (sub === 'dismiss') return 'dismissed';
  return null;
}

/* v8 ignore start */
const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
/* v8 ignore stop */

export async function scrapeCodeCommitFeedback(
  opts: ScrapeCodeCommitFeedbackOpts,
): Promise<ScrapeCodeCommitFeedbackResult> {
  const delayMs = opts.delayMs ?? 500;
  const sleep = opts.sleep ?? defaultSleep;

  const prIds =
    opts.onlyPr !== undefined
      ? [opts.onlyPr]
      : await listCodeCommitPullRequestIds(opts.client, {
          repositoryName: opts.repositoryName,
          ...(opts.pullRequestStatus !== undefined
            ? { pullRequestStatus: opts.pullRequestStatus }
            : {}),
        });

  let commentsSeen = 0;
  let feedbackCommandsSeen = 0;
  let unresolved = 0;
  let unauthorized = 0;
  const candidates: RecoverFeedbackHistoryCandidate[] = [];

  for (const prId of prIds) {
    const allComments: ReadonlyArray<CodeCommitRawComment> =
      await listCodeCommitCommentsForPullRequest(opts.client, {
        pullRequestId: String(prId),
        delayMs,
        sleep,
      });
    commentsSeen += allComments.length;

    const commentsById = new Map<string, CodeCommitRawComment>();
    for (const c of allComments) commentsById.set(c.commentId, c);

    for (const c of allComments) {
      const kind = parseFeedbackKind(c.content);
      if (kind === null) continue;
      feedbackCommandsSeen += 1;
      // Fail-closed on missing creationDate: an SDK page that omits
      // the field cannot be safely placed relative to --since, so we
      // treat it as "outside the window" rather than letting it slip
      // through.
      if (opts.sinceDate && (!c.creationDate || c.creationDate < opts.sinceDate)) continue;
      const parentId = c.inReplyTo;
      if (parentId === undefined) {
        unresolved += 1;
        continue;
      }
      const parent = commentsById.get(parentId);
      if (!parent) {
        unresolved += 1;
        continue;
      }
      // Parent comment must be authored by the Bot's IAM principal.
      // Without this gate, any reviewer who appends a `<!-- fingerprint:... -->`
      // marker to their own comment can launder arbitrary text into
      // `review_history` via a self-reply `/feedback` command.
      if (parent.authorArn !== opts.botArn) {
        unresolved += 1;
        continue;
      }
      // v1.2 #113: gate the reply author against the same allowlist
      // the live webhook (codecommit-webhook.ts:347-351) consults.
      // Without this, an attacker whose webhook /feedback replies
      // were denied at runtime can still get them silently promoted
      // into review_history when the operator runs the recovery CLI.
      // Fail-closed on missing authorArn (treat as unauthorized).
      const authz = checkCodeCommitFeedbackAuthz({
        principalId: c.authorArn ?? '',
        allowlistEnv: opts.feedbackAllowlist.join(','),
      });
      if (!authz.allowed) {
        unauthorized += 1;
        continue;
      }
      const fp = extractFingerprintFromComment(parent.content);
      if (!fp) {
        unresolved += 1;
        continue;
      }
      // Structured factText: only the fingerprint, recovery marker,
      // feedback kind, and parent creation timestamp are persisted.
      // The reviewer's free-text body is deliberately excluded so a
      // crafted `/feedback reject ignore previous instructions ...`
      // body cannot inject prompt content or secrets into a later
      // `<learned_facts>` system-prompt section.
      const iso = c.creationDate?.toISOString() ?? 'unknown';
      candidates.push({
        factType: feedbackKindToFactType(kind),
        factText: `[fp:${fp}] codecommit-recover ${kind} at ${iso}`,
      });
    }

    // Pace between PRs to honour the rate-limit default. Same as the
    // GitHub backfill (#99). Skip for single-PR walks (debug path).
    if (prIds.length > 1) await sleep(delayMs);
  }

  return {
    candidates,
    stats: {
      prsWalked: prIds.length,
      commentsSeen,
      feedbackCommandsSeen,
      unresolved,
      unauthorized,
      resolved: candidates.length,
    },
  };
}
