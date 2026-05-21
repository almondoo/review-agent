import { readFile } from 'node:fs/promises';
import { Octokit } from '@octokit/rest';
import type { PRRef, ReviewState, VCS } from '@review-agent/core';
import {
  createDbClient,
  type DbClient,
  type RecoverEvalEventsResult,
  type RecoverFeedbackHistoryCandidate,
  type RecoverFeedbackHistoryResult,
  recoverFeedbackHistory,
  recoverReviewEvalEvents,
  withTenant,
} from '@review-agent/db';
import {
  type CodeCommitClientLike,
  createDefaultCodeCommitClient,
} from '@review-agent/platform-codecommit';
import { createGithubVCS } from '@review-agent/platform-github';
import type { ProgramIo } from '../io.js';
import { scrapeCodeCommitFeedback } from './recover-codecommit-feedback.js';

export type RecoverPlatform = 'github' | 'codecommit';

export type RecoverSyncStateOpts = {
  readonly repo: string;
  readonly installationId: bigint;
  readonly env: NodeJS.ProcessEnv;
  readonly platform?: RecoverPlatform;
  /** Test seam for the underlying VCS adapter. */
  readonly createVCS?: (token: string) => VCS;
  /** Test seam for the PR-list call. */
  readonly listOpenPRs?: (
    token: string,
    owner: string,
    repo: string,
  ) => Promise<ReadonlyArray<{ number: number }>>;
  /** Persists the recovered ReviewState row keyed by (installationId, prId). */
  readonly upsertState?: (input: {
    installationId: bigint;
    prId: string;
    headSha: string;
    state: ReviewState;
  }) => Promise<void>;
};

export type RecoverSyncStateResult = {
  readonly status: 'ok' | 'auth_failed' | 'partial';
  readonly recovered: number;
  readonly missing: ReadonlyArray<number>;
};

// `review-agent recover sync-state` — spec §8.6.6.
//
// Walks every open PR in the repo, reads its hidden review-state
// comment via the VCS adapter, and upserts the matching review_state
// row. Idempotent: safe to rerun. GitHub-only — CodeCommit
// installations cannot recover state per §12.1.1.
export async function recoverSyncStateCommand(
  io: ProgramIo,
  opts: RecoverSyncStateOpts,
): Promise<RecoverSyncStateResult> {
  const platform: RecoverPlatform = opts.platform ?? 'github';
  if (platform === 'codecommit') {
    io.stderr(
      'recover sync-state is GitHub-only (CodeCommit uses Postgres-canonical state; see docs/operations/codecommit-disaster-recovery.md).\n',
    );
    return { status: 'ok', recovered: 0, missing: [] };
  }
  const token = opts.env.REVIEW_AGENT_GH_TOKEN ?? opts.env.GITHUB_TOKEN;
  if (!token) {
    io.stderr('REVIEW_AGENT_GH_TOKEN (or GITHUB_TOKEN) is required.\n');
    return { status: 'auth_failed', recovered: 0, missing: [] };
  }
  const ref = parseRepo(opts.repo);
  const listOpenPRs = opts.listOpenPRs ?? defaultListOpenPRs;
  const buildVcs = opts.createVCS ?? ((t) => createGithubVCS({ token: t }));
  const vcs = buildVcs(token);
  const upsertState = opts.upsertState ?? requireUpsertCallback(io);

  const prs = await listOpenPRs(token, ref.owner, ref.repo);
  io.stdout(`Found ${prs.length} open PR(s) in ${ref.owner}/${ref.repo}.\n`);

  let recovered = 0;
  const missing: number[] = [];

  for (const pr of prs) {
    const prRef: PRRef = { ...ref, number: pr.number };
    const state = await vcs.getStateComment(prRef);
    if (!state) {
      missing.push(pr.number);
      io.stdout(`  #${pr.number}: no hidden state comment — skipping.\n`);
      continue;
    }
    if (!state.lastReviewedSha) {
      missing.push(pr.number);
      io.stdout(`  #${pr.number}: state comment missing lastReviewedSha — skipping.\n`);
      continue;
    }
    await upsertState({
      installationId: opts.installationId,
      prId: `${ref.owner}/${ref.repo}#${pr.number}`,
      headSha: state.lastReviewedSha,
      state,
    });
    recovered += 1;
    io.stdout(`  #${pr.number}: recovered (head ${state.lastReviewedSha.slice(0, 7)}).\n`);
  }

  io.stdout(
    `\nRecovered ${recovered}/${prs.length} PR state row(s)${
      missing.length > 0 ? `, ${missing.length} skipped: [${missing.join(', ')}]` : ''
    }.\n`,
  );
  return {
    status: missing.length === 0 ? 'ok' : 'partial',
    recovered,
    missing,
  };
}

function parseRepo(repo: string): { platform: 'github'; owner: string; repo: string } {
  const match = /^([^/\s]+)\/([^/\s]+)$/.exec(repo);
  if (!match) {
    throw new Error(`--repo must be in 'owner/repo' format (got '${repo}').`);
  }
  return { platform: 'github', owner: match[1] ?? '', repo: match[2] ?? '' };
}

const defaultListOpenPRs: NonNullable<RecoverSyncStateOpts['listOpenPRs']> = async (
  token,
  owner,
  repo,
) => {
  const octokit = new Octokit({ auth: token });
  const data = await octokit.paginate(octokit.rest.pulls.list, {
    owner,
    repo,
    state: 'open',
    per_page: 100,
  });
  return data.map((pr: { number: number }) => ({ number: pr.number }));
};

function requireUpsertCallback(io: ProgramIo): NonNullable<RecoverSyncStateOpts['upsertState']> {
  return async () => {
    // The CLI does not own a Postgres pool by default — the operator
    // wiring this up should pass `upsertState` explicitly. Surface a
    // clear error rather than silently dropping the recovered state.
    io.stderr('`recover sync-state` requires an upsertState callback to persist results.\n');
    throw new Error('upsertState callback not provided');
  };
}

// ---------------------------------------------------------------------------
// v1.2 #105 — `recover review-eval-events` / `recover feedback-history`.
//
// Both subcommands run under a single tenant (`--installation-id` +
// `--repo`) and are idempotent: re-running with the same args inserts
// nothing on the second pass.
// ---------------------------------------------------------------------------

export type RecoverReviewEvalEventsOpts = {
  readonly repo: string;
  readonly installationId: bigint;
  readonly env: NodeJS.ProcessEnv;
  readonly platform?: RecoverPlatform;
  readonly since?: string;
  readonly dryRun?: boolean;
  /** Test seam — provides a DbClient + close pair. */
  readonly createDb?: (url: string) => { db: DbClient; close: () => Promise<void> };
};

export async function recoverReviewEvalEventsCommand(
  io: ProgramIo,
  opts: RecoverReviewEvalEventsOpts,
): Promise<RecoverEvalEventsResult> {
  if ((opts.platform ?? 'github') === 'codecommit') {
    io.stderr(
      'recover review-eval-events: --platform codecommit is supported (cost_ledger source is provider-agnostic); pass --platform github for the same effect or omit.\n',
    );
  }
  const dbUrl = opts.env.DATABASE_URL ?? '';
  if (!dbUrl) {
    io.stderr('DATABASE_URL is required for `recover review-eval-events`.\n');
    return { status: 'ok', candidates: 0, recovered: 0, skippedExisting: 0 };
  }
  const makeDb = opts.createDb ?? ((u: string) => createDbClient({ url: u }));
  const { db, close } = makeDb(dbUrl);
  try {
    const since = opts.since ? new Date(opts.since) : undefined;
    const result = await withTenant(db, opts.installationId, () =>
      recoverReviewEvalEvents(db, {
        installationId: opts.installationId,
        repo: opts.repo,
        ...(since ? { since } : {}),
        ...(opts.dryRun !== undefined ? { dryRun: opts.dryRun } : {}),
      }),
    );
    io.stdout(
      `review-eval-events recovery for installation=${opts.installationId} repo=${opts.repo}: ` +
        `candidates=${result.candidates} recovered=${result.recovered} skippedExisting=${result.skippedExisting}` +
        (opts.dryRun ? ' (dry-run; no inserts)' : '') +
        '\n',
    );
    return result;
  } finally {
    await close();
  }
}

export type RecoverFeedbackHistoryOpts = {
  readonly repo: string;
  readonly installationId: bigint;
  readonly env: NodeJS.ProcessEnv;
  readonly platform: RecoverPlatform;
  /** Required when `platform === 'github'`. */
  readonly candidatesFile?: string;
  readonly dryRun?: boolean;
  /** v1.2 #110: optional date filter applied to CodeCommit comment creation date. */
  readonly since?: string;
  /** v1.2 #110: optional single-PR scope for CodeCommit debug runs. */
  readonly onlyPr?: number;
  /** v1.2 #110: CodeCommit rate-limit pacing (req/sec); converted to delayMs. */
  readonly rate?: number;
  readonly createDb?: (url: string) => { db: DbClient; close: () => Promise<void> };
  /** Test seam: read the candidates file from disk. */
  readonly readFile?: (path: string) => Promise<string>;
  /** Test seam: provide a CodeCommit client (the production path
   *  defers to AWS_REGION / AWS_PROFILE via the platform-codecommit
   *  default constructor). */
  readonly codecommitClient?: CodeCommitClientLike;
};

export async function recoverFeedbackHistoryCommand(
  io: ProgramIo,
  opts: RecoverFeedbackHistoryOpts,
): Promise<RecoverFeedbackHistoryResult> {
  const dbUrl = opts.env.DATABASE_URL ?? '';
  if (!dbUrl) {
    io.stderr('DATABASE_URL is required for `recover feedback-history`.\n');
    return { status: 'ok', candidates: 0, recovered: 0, skippedExisting: 0 };
  }

  // Source candidates either from a JSONL file (GitHub) or from a
  // direct CodeCommit `/feedback` re-scrape (#110).
  let candidates: ReadonlyArray<RecoverFeedbackHistoryCandidate>;
  if (opts.platform === 'codecommit') {
    // Production path constructs a default CodeCommit client (picks
    // up AWS_REGION / AWS_PROFILE from the env chain); tests inject
    // a stub via `opts.codecommitClient`.
    const client = opts.codecommitClient ?? createDefaultCodeCommitClient();
    // Locked Q1 (#110): default 2 req/sec → 500ms delay between page
    // calls. operator-tunable.
    const delayMs = opts.rate && opts.rate > 0 ? Math.floor(1000 / opts.rate) : 500;
    const sinceDate = opts.since ? new Date(opts.since) : undefined;
    const scrape = await scrapeCodeCommitFeedback({
      client,
      repositoryName: opts.repo.includes('/') ? (opts.repo.split('/')[1] ?? opts.repo) : opts.repo,
      ...(sinceDate ? { sinceDate } : {}),
      ...(opts.onlyPr !== undefined ? { onlyPr: opts.onlyPr } : {}),
      delayMs,
    });
    candidates = scrape.candidates;
    io.stdout(
      `codecommit re-scrape: walked ${scrape.stats.prsWalked} PR(s), ` +
        `${scrape.stats.commentsSeen} comments, ` +
        `${scrape.stats.feedbackCommandsSeen} /feedback commands found, ` +
        `${scrape.stats.resolved} resolved, ${scrape.stats.unresolved} unresolved (skipped).\n`,
    );
  } else {
    if (!opts.candidatesFile) {
      io.stderr('recover feedback-history --platform github requires --candidates-file <path>.\n');
      return { status: 'ok', candidates: 0, recovered: 0, skippedExisting: 0 };
    }
    const reader = opts.readFile ?? ((p: string) => readFile(p, 'utf8'));
    const raw = await reader(opts.candidatesFile);
    candidates = parseCandidatesFile(raw);
  }

  const makeDb = opts.createDb ?? ((u: string) => createDbClient({ url: u }));
  const { db, close } = makeDb(dbUrl);
  try {
    const result = await withTenant(db, opts.installationId, () =>
      recoverFeedbackHistory(db, {
        installationId: opts.installationId,
        repo: opts.repo,
        candidates,
        ...(opts.dryRun !== undefined ? { dryRun: opts.dryRun } : {}),
      }),
    );
    io.stdout(
      `feedback-history recovery for installation=${opts.installationId} repo=${opts.repo}: ` +
        `candidates=${result.candidates} recovered=${result.recovered} skippedExisting=${result.skippedExisting}` +
        (opts.dryRun ? ' (dry-run; no inserts)' : '') +
        '\n',
    );
    return result;
  } finally {
    await close();
  }
}

/**
 * Parses a JSONL candidates file produced by the operator from an
 * out-of-band source (logs, prior `feedback backfill --dry-run`
 * export, manual SQL extract). One JSON object per line:
 *
 *   { "factType": "rejected_finding", "factText": "[fp:abcdef0123456789] ..." }
 *
 * Blank lines and `//`-prefixed comments are ignored so operators can
 * annotate.
 */
function parseCandidatesFile(raw: string): RecoverFeedbackHistoryCandidate[] {
  const lines = raw.split('\n');
  const out: RecoverFeedbackHistoryCandidate[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('//')) continue;
    const parsed = JSON.parse(trimmed) as {
      factType?: string;
      factText?: string;
    };
    if (
      parsed.factType !== 'accepted_pattern' &&
      parsed.factType !== 'rejected_finding' &&
      parsed.factType !== 'arch_decision'
    ) {
      throw new Error(`Invalid factType in candidates file: ${String(parsed.factType)}`);
    }
    if (typeof parsed.factText !== 'string' || parsed.factText === '') {
      throw new Error('Invalid factText in candidates file (must be a non-empty string).');
    }
    out.push({ factType: parsed.factType, factText: parsed.factText });
  }
  return out;
}
