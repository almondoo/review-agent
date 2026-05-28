import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Octokit } from '@octokit/rest';
import { fingerprint as defaultFingerprint, type FeedbackEvent } from '@review-agent/core';
import { createDbClient, createReviewHistoryWriter, type DbClient } from '@review-agent/db';
import { createFeedbackWriter, type ReviewHistoryWriter } from '@review-agent/runner';
import type { ProgramIo } from '../io.js';

/**
 * `review-agent feedback backfill` — v1.2 follow-on #99.
 *
 * Walks every PR in a GitHub repo, lists each Bot-authored review
 * comment, then ingests `+1` / `-1` reactions on those comments into
 * `review_history`. Operators run this once after deploying Phase 3
 * (#92) so months of historical reactions are not stranded outside
 * the `<learned_facts>` cold-start window (spec §7.6 / §7.6.1).
 *
 * Design highlights:
 *
 * - **`maxWritesPerJob: 'unlimited'`** — backfill is the one path
 *   that consciously opts out of the per-job 10-write cap. The
 *   sentinel string is type-checked so a typo'd number can never
 *   silently disable the cap on the webhook path.
 * - **Per-PR state file** — operators expect to interrupt and resume
 *   a multi-hour backfill. State is flushed per PR with the highest
 *   processed `(commentId, reactionId)` so re-running picks up where
 *   it left off.
 * - **Rate limiter** — GitHub authenticated requests are capped at
 *   5000/hour. The CLI sleeps between requests (`--rate`, default
 *   2 req/sec, i.e. 7200/hour ceiling). Operators tune downward for
 *   noisy-neighbour installations.
 * - **GitHub-only** — CodeCommit `/feedback` backfill is the
 *   separate #95 follow-up; we reject early with a helpful message.
 * - **Fingerprint resolution** — prefers an embedded `<!-- fingerprint:<fp> -->`
 *   marker (per #96, not yet landed). Falls back to recomputing
 *   `fingerprint({ path, line, ruleId, suggestionType })` from the
 *   comment metadata, using the same shape as the dedup middleware
 *   so cold-start rows align with what Phase 4's reader expects.
 */

// Minimal Octokit-shaped surface we depend on. Keeping it explicit
// makes the CLI testable without pulling Octokit's full type into a
// fake — the same approach the `recover sync-state` command uses.
export type BackfillOctokit = {
  readonly rest: {
    readonly pulls: {
      readonly list: (args: {
        readonly owner: string;
        readonly repo: string;
        readonly state: 'all';
        readonly per_page: number;
        readonly page: number;
        readonly sort?: 'updated';
        readonly direction?: 'desc';
      }) => Promise<{ readonly data: ReadonlyArray<BackfillPr> }>;
      readonly listReviewComments: (args: {
        readonly owner: string;
        readonly repo: string;
        readonly pull_number: number;
        readonly per_page: number;
        readonly page: number;
      }) => Promise<{ readonly data: ReadonlyArray<BackfillReviewComment> }>;
    };
    readonly reactions: {
      readonly listForPullRequestReviewComment: (args: {
        readonly owner: string;
        readonly repo: string;
        readonly comment_id: number;
        readonly per_page: number;
        readonly page: number;
      }) => Promise<{ readonly data: ReadonlyArray<BackfillReaction> }>;
    };
  };
};

export type BackfillPr = {
  readonly number: number;
  readonly updated_at?: string;
};

export type BackfillReviewComment = {
  readonly id: number;
  readonly path?: string | null;
  readonly line?: number | null;
  readonly original_line?: number | null;
  readonly body?: string | null;
  readonly user?: { readonly login?: string | null; readonly type?: string | null } | null;
};

export type BackfillReaction = {
  readonly id: number;
  readonly content: string;
  readonly user?: { readonly login?: string | null } | null;
  readonly created_at: string;
};

// Per-PR resume state. The file lives at `<state-file>` and is a
// JSON object keyed by `pr#<number>`; each entry tracks the highest
// processed `(commentId, reactionId)` and aggregate counters so the
// final summary is correct even after multiple resume cycles.
export type BackfillPrState = {
  readonly lastCommentId: number;
  readonly lastReactionId: number;
  readonly processed: number;
  readonly recorded: number;
  readonly unresolved: number;
  readonly skipped: number;
  readonly completed: boolean;
};

export type BackfillStateFile = {
  readonly version: 1;
  readonly repo: string;
  readonly installationId: string;
  readonly prs: Record<string, BackfillPrState>;
};

export type FeedbackBackfillPlatform = 'github' | 'codecommit';

export type FeedbackBackfillOpts = {
  readonly installationId: bigint;
  readonly repo: string;
  readonly env: NodeJS.ProcessEnv;
  readonly platform?: FeedbackBackfillPlatform;
  readonly since?: string;
  readonly stateFile?: string;
  readonly dryRun?: boolean;
  readonly rate?: number;
  /**
   * Override for the bot login the CLI treats as "review-agent
   * authored". Defaults to env `REVIEW_AGENT_BOT_LOGIN`, then to a
   * permissive "any GitHub App bot" check via `user.type === 'Bot'`.
   * Operators with multi-bot repos pin this to avoid ingesting
   * reactions on dependabot / renovate comments.
   */
  readonly botLogin?: string;
  // Test seams ---------------------------------------------------------
  readonly createOctokit?: (token: string) => BackfillOctokit;
  readonly createDb?: (url: string) => { db: DbClient; close: () => Promise<void> };
  readonly buildWriter?: (db: DbClient) => ReviewHistoryWriter;
  readonly readState?: (path: string) => Promise<string | null>;
  readonly writeState?: (path: string, data: string) => Promise<void>;
  readonly sleep?: (ms: number) => Promise<void>;
};

export type FeedbackBackfillResult = {
  readonly status:
    | 'ok'
    | 'dry_run'
    | 'auth_failed'
    | 'config_error'
    | 'invalid_args'
    | 'platform_unsupported';
  readonly processed: number;
  readonly recorded: number;
  readonly unresolved: number;
  readonly skipped: number;
};

const DEFAULT_RATE_REQ_PER_SEC = 2;
const PR_PAGE_SIZE = 100;
const COMMENT_PAGE_SIZE = 100;
const REACTION_PAGE_SIZE = 100;
const BACKFILL_FALLBACK_RULE_ID = 'backfill-unknown';

export async function feedbackBackfillCommand(
  io: ProgramIo,
  opts: FeedbackBackfillOpts,
): Promise<FeedbackBackfillResult> {
  const platform: FeedbackBackfillPlatform = opts.platform ?? 'github';
  if (platform === 'codecommit') {
    io.stderr(
      'feedback backfill is GitHub-only. CodeCommit installations require the ' +
        '`/feedback` comment-command scrape from issue #95 (not yet landed). ' +
        'See docs/operations/feedback-backfill.md.\n',
    );
    return zeroResult('platform_unsupported');
  }

  const ref = parseRepo(opts.repo);
  if (!ref) {
    io.stderr(`--repo must be in 'owner/repo' format (got '${opts.repo}').\n`);
    return zeroResult('invalid_args');
  }

  let since: Date | undefined;
  if (opts.since !== undefined) {
    const parsed = parseIsoDate(opts.since);
    if (!parsed) {
      io.stderr(`--since must be a YYYY-MM-DD date (got '${opts.since}').\n`);
      return zeroResult('invalid_args');
    }
    since = parsed;
  }

  const rate = opts.rate ?? DEFAULT_RATE_REQ_PER_SEC;
  if (!Number.isFinite(rate) || rate <= 0) {
    io.stderr(`--rate must be a positive number (got '${opts.rate}').\n`);
    return zeroResult('invalid_args');
  }

  const token = opts.env.REVIEW_AGENT_GH_TOKEN ?? opts.env.GITHUB_TOKEN;
  if (!token) {
    io.stderr('REVIEW_AGENT_GH_TOKEN (or GITHUB_TOKEN) is required.\n');
    return zeroResult('auth_failed');
  }

  const dryRun = !!opts.dryRun;
  const dbUrl = opts.env.DATABASE_URL ?? opts.env.REVIEW_AGENT_DATABASE_URL;
  if (!dryRun && !dbUrl && !opts.createDb) {
    io.stderr(
      'DATABASE_URL (or REVIEW_AGENT_DATABASE_URL) is required when not running with --dry-run.\n',
    );
    return zeroResult('config_error');
  }

  const botLogin = opts.botLogin ?? opts.env.REVIEW_AGENT_BOT_LOGIN;
  const sleep = opts.sleep ?? defaultSleep;
  const delayMs = Math.round(1000 / rate);

  const makeOctokit = opts.createOctokit ?? defaultCreateOctokit;
  const octokit = makeOctokit(token);

  const stateFile = opts.stateFile;
  const readState = opts.readState ?? defaultReadState;
  const writeState = opts.writeState ?? defaultWriteState;

  const state = stateFile
    ? await loadStateFile(readState, stateFile, ref.repoFull, opts.installationId)
    : emptyState(ref.repoFull, opts.installationId);

  // Wire the persistence side only when we're actually going to
  // write. Dry-run uses a no-op writer so the rest of the pipeline
  // (pagination, redaction, fingerprint resolve) still exercises.
  let closeDb: (() => Promise<void>) | null = null;
  let recordFeedback: (ev: FeedbackEvent) => Promise<{ dropped: boolean }>;
  if (dryRun) {
    recordFeedback = async () => ({ dropped: false });
  } else {
    const makeDb = opts.createDb ?? ((u: string) => createDbClient({ url: u }));
    const { db, close } = makeDb(dbUrl ?? '');
    closeDb = close;
    const persistenceWriter = (opts.buildWriter ?? createReviewHistoryWriter)(db);
    const fb = createFeedbackWriter({ writer: persistenceWriter, maxWritesPerJob: 'unlimited' });
    recordFeedback = fb.record;
  }

  let totals = { processed: 0, recorded: 0, unresolved: 0, skipped: 0 };

  try {
    io.stdout(
      `Backfilling ${ref.owner}/${ref.repo} for installation ${opts.installationId} ` +
        `(rate=${rate}/s${dryRun ? ', dry-run' : ''}${since ? `, since=${opts.since}` : ''}).\n`,
    );

    for await (const pr of paginatePrs(octokit, ref, since, sleep, delayMs)) {
      const prKey = `pr#${pr.number}`;
      const prState = state.prs[prKey];
      if (prState?.completed) {
        io.stdout(`  #${pr.number}: already completed in prior run — skipping.\n`);
        // Re-fold prior totals into the summary so resume reports a
        // running aggregate across resume cycles rather than just
        // this run's deltas.
        totals = addTotals(totals, prState);
        continue;
      }
      const prResult = await processPr(io, octokit, ref, pr, prState, {
        installationId: opts.installationId,
        botLogin,
        recordFeedback,
        sleep,
        delayMs,
        dryRun,
      });
      totals = addTotals(totals, prResult);
      state.prs[prKey] = {
        lastCommentId: prResult.lastCommentId,
        lastReactionId: prResult.lastReactionId,
        processed: prResult.processed,
        recorded: prResult.recorded,
        unresolved: prResult.unresolved,
        skipped: prResult.skipped,
        completed: true,
      };
      if (stateFile) await persistStateFile(writeState, stateFile, state);
    }

    io.stdout(
      `\nprocessed: ${totals.processed} | recorded: ${totals.recorded} | ` +
        `unresolved: ${totals.unresolved} | skipped (duplicate): ${totals.skipped}\n`,
    );
    return {
      status: dryRun ? 'dry_run' : 'ok',
      processed: totals.processed,
      recorded: totals.recorded,
      unresolved: totals.unresolved,
      skipped: totals.skipped,
    };
  } finally {
    if (closeDb) await closeDb();
  }
}

// ---------------------------------------------------------------------
// PR / comment / reaction iteration helpers
// ---------------------------------------------------------------------

async function* paginatePrs(
  octokit: BackfillOctokit,
  ref: RepoRef,
  since: Date | undefined,
  sleep: (ms: number) => Promise<void>,
  delayMs: number,
): AsyncIterable<BackfillPr> {
  let page = 1;
  while (true) {
    if (delayMs > 0 && page > 1) await sleep(delayMs);
    const { data } = await octokit.rest.pulls.list({
      owner: ref.owner,
      repo: ref.repo,
      state: 'all',
      per_page: PR_PAGE_SIZE,
      page,
      sort: 'updated',
      direction: 'desc',
    });
    if (data.length === 0) return;
    let crossedSince = false;
    for (const pr of data) {
      if (since && pr.updated_at) {
        const u = new Date(pr.updated_at);
        if (Number.isFinite(u.getTime()) && u < since) {
          crossedSince = true;
          break;
        }
      }
      yield pr;
    }
    if (crossedSince) return;
    if (data.length < PR_PAGE_SIZE) return;
    page += 1;
  }
}

type PrRunTotals = {
  readonly processed: number;
  readonly recorded: number;
  readonly unresolved: number;
  readonly skipped: number;
  readonly lastCommentId: number;
  readonly lastReactionId: number;
};

type ProcessPrCtx = {
  readonly installationId: bigint;
  readonly botLogin: string | undefined;
  readonly recordFeedback: (ev: FeedbackEvent) => Promise<{ dropped: boolean }>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly delayMs: number;
  readonly dryRun: boolean;
};

async function processPr(
  io: ProgramIo,
  octokit: BackfillOctokit,
  ref: RepoRef,
  pr: BackfillPr,
  prior: BackfillPrState | undefined,
  ctx: ProcessPrCtx,
): Promise<PrRunTotals> {
  let processed = prior?.processed ?? 0;
  let recorded = prior?.recorded ?? 0;
  let unresolved = prior?.unresolved ?? 0;
  let skipped = prior?.skipped ?? 0;
  let lastCommentId = prior?.lastCommentId ?? 0;
  let lastReactionId = prior?.lastReactionId ?? 0;
  const startCommentId = prior?.lastCommentId ?? 0;
  const startReactionId = prior?.lastReactionId ?? 0;

  let commentPage = 1;
  while (true) {
    if (ctx.delayMs > 0 && commentPage > 1) await ctx.sleep(ctx.delayMs);
    const { data: comments } = await octokit.rest.pulls.listReviewComments({
      owner: ref.owner,
      repo: ref.repo,
      pull_number: pr.number,
      per_page: COMMENT_PAGE_SIZE,
      page: commentPage,
    });
    if (comments.length === 0) break;
    for (const comment of comments) {
      if (!isBotComment(comment, ctx.botLogin)) continue;
      // Resume invariant: skip already-processed comments. We allow
      // == to revisit the boundary comment so a partial reaction
      // sweep on the prior run can finish.
      if (comment.id < startCommentId) continue;
      const fp = resolveFingerprint(comment);
      if (!fp) {
        unresolved += 1;
        io.stdout(`  #${pr.number} comment ${comment.id}: unresolved fingerprint — skipping.\n`);
        continue;
      }
      let reactionPage = 1;
      while (true) {
        if (ctx.delayMs > 0) await ctx.sleep(ctx.delayMs);
        const { data: reactions } = await octokit.rest.reactions.listForPullRequestReviewComment({
          owner: ref.owner,
          repo: ref.repo,
          comment_id: comment.id,
          per_page: REACTION_PAGE_SIZE,
          page: reactionPage,
        });
        if (reactions.length === 0) break;
        for (const reaction of reactions) {
          // Resume invariant inside the reaction loop only for the
          // exact comment we last partially processed.
          if (
            comment.id === startCommentId &&
            startReactionId > 0 &&
            reaction.id <= startReactionId
          ) {
            continue;
          }
          const kind = mapReactionContent(reaction.content);
          if (!kind) continue;
          processed += 1;
          const ev: FeedbackEvent = {
            installationId: ctx.installationId,
            repo: ref.repoFull,
            prNumber: pr.number,
            fingerprint: fp,
            kind,
            factText: `${kind === 'thumbs_up' ? '👍' : '👎'} reaction by ${
              reaction.user?.login ?? 'unknown'
            } (backfill)`,
            occurredAt: new Date(reaction.created_at),
          };
          if (ctx.dryRun) {
            recorded += 1;
          } else {
            const result = await ctx.recordFeedback(ev);
            if (result.dropped) skipped += 1;
            else recorded += 1;
          }
          lastReactionId = reaction.id;
          io.stdout(
            `  #${pr.number} comment ${comment.id} reaction ${reaction.id}: ${kind} by ${
              reaction.user?.login ?? 'unknown'
            }${ctx.dryRun ? ' (dry-run)' : ''}\n`,
          );
        }
        if (reactions.length < REACTION_PAGE_SIZE) break;
        reactionPage += 1;
      }
      lastCommentId = comment.id;
    }
    if (comments.length < COMMENT_PAGE_SIZE) break;
    commentPage += 1;
  }

  return { processed, recorded, unresolved, skipped, lastCommentId, lastReactionId };
}

// ---------------------------------------------------------------------
// Comment classification / fingerprint resolution
// ---------------------------------------------------------------------

function isBotComment(comment: BackfillReviewComment, botLogin?: string): boolean {
  // Operator pin first — when set we require an exact match, so a
  // typo'd value reliably zeroes out the run instead of ingesting
  // every bot's reactions.
  if (botLogin) return comment.user?.login === botLogin;
  // Fallback: any GitHub App bot. This is necessarily permissive;
  // operators with multiple bots in a repo should pin `--bot-login`.
  return comment.user?.type === 'Bot';
}

const REACTION_KIND_MAP: Record<string, 'thumbs_up' | 'thumbs_down' | undefined> = {
  '+1': 'thumbs_up',
  '-1': 'thumbs_down',
};

function mapReactionContent(content: string): 'thumbs_up' | 'thumbs_down' | null {
  return REACTION_KIND_MAP[content] ?? null;
}

/**
 * Resolve the fingerprint of a posted comment. The preferred path is
 * the explicit `<!-- fingerprint:<fp> -->` marker that lands with
 * issue #96. Until then we fall back to recomputing the dedup-shaped
 * fingerprint from comment metadata. Returns `null` when neither
 * path works — operators see the count in the final summary's
 * `unresolved` field.
 */
export function resolveFingerprint(comment: BackfillReviewComment): string | null {
  const body = comment.body ?? '';
  const embedded = /<!--\s*fingerprint:([0-9a-f]+)\s*-->/.exec(body);
  if (embedded?.[1]) return embedded[1];
  const path = comment.path ?? null;
  const line = comment.line ?? comment.original_line ?? null;
  if (!path || !line) return null;
  const ruleId = parseRuleIdFromBody(body) ?? BACKFILL_FALLBACK_RULE_ID;
  return defaultFingerprint({
    path,
    line,
    ruleId,
    suggestionType: 'comment',
  });
}

function parseRuleIdFromBody(body: string): string | null {
  // Optional `<!-- rule:<id> -->` marker — not currently emitted by
  // the agent (no v1.x writer sets it) but kept here so #96 / future
  // changes can opt in without touching the backfill code path.
  const m = /<!--\s*rule:([a-z][a-z0-9-]+)\s*-->/.exec(body);
  return m?.[1] ?? null;
}

// ---------------------------------------------------------------------
// State file
// ---------------------------------------------------------------------

function emptyState(repoFull: string, installationId: bigint): BackfillStateFile {
  return {
    version: 1,
    repo: repoFull,
    installationId: installationId.toString(),
    prs: {},
  };
}

async function loadStateFile(
  read: (path: string) => Promise<string | null>,
  path: string,
  repoFull: string,
  installationId: bigint,
): Promise<BackfillStateFile> {
  const raw = await read(path);
  if (raw === null) return emptyState(repoFull, installationId);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`state-file ${path} is not valid JSON: ${(e as Error).message}`);
  }
  if (!isBackfillStateFile(parsed)) {
    throw new Error(`state-file ${path} schema does not match BackfillStateFile`);
  }
  // We intentionally do NOT enforce that the repo / installation
  // match — the operator may rename a state-file across runs. We
  // surface the loaded values so the caller can sanity-check.
  return parsed;
}

function isBackfillStateFile(v: unknown): v is BackfillStateFile {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  if (o.version !== 1) return false;
  if (typeof o.repo !== 'string') return false;
  if (typeof o.installationId !== 'string') return false;
  if (typeof o.prs !== 'object' || o.prs === null) return false;
  return true;
}

async function persistStateFile(
  write: (path: string, data: string) => Promise<void>,
  path: string,
  state: BackfillStateFile,
): Promise<void> {
  const data = JSON.stringify(state, null, 2);
  await write(path, data);
}

const defaultReadState = async (path: string): Promise<string | null> => {
  /* v8 ignore start */
  try {
    return await readFile(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
  /* v8 ignore stop */
};

const defaultWriteState = async (path: string, data: string): Promise<void> => {
  /* v8 ignore start */
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, data, 'utf8');
  /* v8 ignore stop */
};

// ---------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------

type RepoRef = {
  readonly owner: string;
  readonly repo: string;
  readonly repoFull: string;
};

function parseRepo(repo: string): RepoRef | null {
  const match = /^([^/\s]+)\/([^/\s]+)$/.exec(repo);
  if (!match) return null;
  // noUncheckedIndexedAccess types match[N] as `string | undefined`, but a
  // successful match guarantees both capture groups are present.
  /* v8 ignore next 2 */
  const owner = match[1] ?? '';
  const name = match[2] ?? '';
  return { owner, repo: name, repoFull: `${owner}/${name}` };
}

function parseIsoDate(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}(T.+)?$/.test(value)) return null;
  const parsed = value.includes('T') ? new Date(value) : new Date(`${value}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function zeroResult(status: FeedbackBackfillResult['status']): FeedbackBackfillResult {
  return { status, processed: 0, recorded: 0, unresolved: 0, skipped: 0 };
}

function addTotals<
  T extends Pick<PrRunTotals, 'processed' | 'recorded' | 'unresolved' | 'skipped'>,
>(
  base: { processed: number; recorded: number; unresolved: number; skipped: number },
  delta: T,
): { processed: number; recorded: number; unresolved: number; skipped: number } {
  return {
    processed: base.processed + delta.processed,
    recorded: base.recorded + delta.recorded,
    unresolved: base.unresolved + delta.unresolved,
    skipped: base.skipped + delta.skipped,
  };
}

/* v8 ignore start */
const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
/* v8 ignore stop */

/* v8 ignore start */
const defaultCreateOctokit = (token: string): BackfillOctokit => {
  // The CLI bin wires this via a real `@octokit/rest` Octokit. Tests
  // pass `createOctokit` directly so they don't depend on a token.
  return new Octokit({ auth: token }) as unknown as BackfillOctokit;
};
/* v8 ignore stop */
