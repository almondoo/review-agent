import { Octokit } from '@octokit/rest';
import type { PRRef, ReviewState, VCS } from '@review-agent/core';
import { createGithubVCS } from '@review-agent/platform-github';
import type { ProgramIo } from '../io.js';

export type RecoverSyncStateOpts = {
  readonly repo: string;
  readonly installationId: bigint;
  readonly env: NodeJS.ProcessEnv;
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
