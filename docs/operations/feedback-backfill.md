# Feedback backfill — `review-agent feedback backfill`

## Why this exists

v1.2 Phase 3 (#92) introduced `review_history` and the writer that ingests
`+1` / `-1` reactions and `pull_request_review.dismissed` events in real
time, via the GitHub webhook receive path. Phase 4 (#93) reads those rows
back into the system prompt as `<learned_facts>...</learned_facts>`.

Tenants who deployed v1.2 **after** their bot had been posting reviews
for a while have a **cold-start problem**: every `+1` / `-1` reaction
left on a pre-deploy comment is invisible to the agent because the
webhook never ran against it. `feedback backfill` is the one-shot tool
to walk historical PRs, harvest those reactions, and seed
`review_history` for the cold-start window.

This is **GitHub-only**. CodeCommit has no native reactions feature;
the equivalent path for CodeCommit operators is the `/feedback` comment
command being tracked in #95. The CLI rejects `--platform codecommit`
with a pointer to that issue.

## Prerequisites

| Concern | Requirement |
|---|---|
| `review_history` table exists | Phase 3 migration (#92) applied. Run `pnpm db:migrate` first. |
| DB role | A role that bypasses RLS (same role used by the migrate runner). See [`retention.md`](./retention.md) "Required DB role" — the same advice applies here. |
| GitHub auth | A token with `pull_requests: read`, `contents: read` on the target repo. Pass via `REVIEW_AGENT_GH_TOKEN` or `GITHUB_TOKEN`. For multi-tenant App-mode installs, generate an installation token offline and pass it via `REVIEW_AGENT_GH_TOKEN`. |
| Disk | `--state-file` lives somewhere the operator can survive between runs (laptop home dir, ops bastion volume). Do **not** put it inside `tmp/` if you intend to resume across reboots. |

## Usage

```sh
# 1) Dry-run first — counts what would land in review_history, writes nothing.
review-agent feedback backfill \
  --installation-id 12345 \
  --repo my-org/my-repo \
  --since 2026-01-01 \
  --state-file ./backfill-my-repo.json \
  --dry-run

# 2) Actual ingest. Same arguments minus --dry-run.
review-agent feedback backfill \
  --installation-id 12345 \
  --repo my-org/my-repo \
  --since 2026-01-01 \
  --state-file ./backfill-my-repo.json \
  --rate 2
```

### Flags

| Flag | Required | Default | Notes |
|---|---|---|---|
| `--installation-id <id>` | yes | — | GitHub App installation id (matches the row that emits webhooks). |
| `--repo <owner/repo>` | yes | — | Repo to scan. |
| `--platform <platform>` | no | `github` | `codecommit` is rejected with a pointer to #95. |
| `--since <YYYY-MM-DD>` | no | — | Skip PRs whose `updated_at` predates this. The CLI sorts PR list by `updated desc` and stops as soon as it crosses the boundary. |
| `--state-file <path>` | no | — | JSON resume file. Per-PR `lastCommentId` / `lastReactionId` + counters. Re-running with the same path picks up where it left off and refuses to double-write. |
| `--dry-run` | no | `false` | Computes the plan without inserting `review_history` rows. The writer is still constructed (so the rate-limit-disabled path is exercised) but its persistence callback is a no-op. |
| `--rate <req-per-sec>` | no | `2` | GitHub API authenticated quota is 5000/hour (≈ 1.4/sec). Default `2` is intentionally a hair over a long-run sustainable rate; tune downward (e.g. `0.5`) for noisy installations. |
| `--bot-login <login>` | no | — | Pins the bot login that authored the review comments to ingest. When unset, ANY `user.type === 'Bot'` comment qualifies. Multi-bot repos (Dependabot + review-agent) **should** pin this. Also accepted via `REVIEW_AGENT_BOT_LOGIN`. |

### Output

```
Backfilling my-org/my-repo for installation 12345 (rate=2/s).
  #421 comment 982344 reaction 19223: thumbs_up by alice
  #421 comment 982345 reaction 19224: thumbs_down by bob
  #420: already completed in prior run — skipping.
  #419 comment 981002: unresolved fingerprint — skipping.

processed: 2 | recorded: 2 | unresolved: 1 | skipped (duplicate): 0
```

- `processed` — `+1` / `-1` reactions we recognised.
- `recorded` — rows actually inserted into `review_history` (or
  `processed` in dry-run).
- `unresolved` — comments whose fingerprint we couldn't derive (no
  `<!-- fingerprint:<fp> -->` marker, no `path` / `line` metadata).
  Operators see this for very old comments that no longer expose
  `original_line`.
- `skipped (duplicate)` — writer-side dedup drops (rare with backfill
  since we use `maxWritesPerJob: 'unlimited'` — would mainly be
  surfaced if a hypothetical operator wired their own writer with a
  different cap).

## Interruption and resume

The CLI flushes `--state-file` **after each PR completes**. If a run is
killed, the next run with the same `--state-file` will:

1. Skip every PR marked `completed: true`.
2. Pick up the half-finished PR (`completed: false`) at the next
   comment/reaction after the recorded `(lastCommentId,
   lastReactionId)`.
3. Continue iterating remaining PRs.

The `--state-file` JSON shape is stable (`version: 1`) — operators may
inspect it between runs but should not hand-edit unless rewinding a
mistaken run (clear a PR entry to reprocess it). The CLI does not
attempt schema migration; future schema bumps will refuse mismatched
versions.

### Worked re-run example

```sh
# Initial run — gets through PR #100, then SIGINT mid-PR #101.
review-agent feedback backfill --installation-id 1 --repo o/r \
  --state-file ./resume.json

# Resume — state file says PR #100 done, PR #101 last reaction id 42.
# This run finishes PR #101 reactions after 42, then continues #102+.
review-agent feedback backfill --installation-id 1 --repo o/r \
  --state-file ./resume.json
```

## Cost / rate-limit budget

For an installation with `P` PRs and `C` Bot-authored comments per PR:

```
requests ≈ 1                           (initial PR list page, then more if > 100 PRs)
        + ceil(P / 100)                (subsequent PR list pages)
        + sum_p(ceil(C_p / 100))       (review-comments per PR)
        + sum_p(C_p)                   (1 reactions call per comment)
```

Empirically, ~95 % of cost is the per-comment reactions call. A repo
with **1000 PRs averaging 20 Bot comments each** ≈ 20,000 reactions
calls plus ~120 PR-list / review-comments calls; at `--rate 2` that
takes ~2.8 hours. **Don't go faster than `--rate 4` unless your
installation is the only consumer of the App token** — the agent
itself runs against the same quota.

## What is NOT done by this CLI

- `dismissed` review backfill — GitHub's API does not list past
  `pull_request_review.dismissed` events, so dismiss-driven
  `rejected_finding` rows can only land via the live webhook path.
  (Out of scope per #99.)
- CodeCommit `/feedback` comment scrape — tracked in #95.
- Automatic recurring sweeps — backfill is intentionally one-shot.
  Operators who want periodic ingestion should rely on the webhook
  receiver; missed webhooks should be replayed via the GitHub
  Webhook Deliveries UI, not by re-running backfill.
- Cross-comment fingerprint reconciliation — when #96 lands and
  posted comments start carrying `<!-- fingerprint:<fp> -->`, backfill
  will automatically prefer the embedded marker over re-fingerprinting.
  No re-run is required for new comments; older comments stay on the
  fallback path.

## Tying the room together

After a successful backfill:

1. Phase 4's reader (`composeSystemPrompt`'s `learnedFacts` option)
   picks up the new rows on the next review of the same `(installation_id,
   repo)`.
2. The dedup middleware's `rejectedFingerprints` set populates from
   `factType: 'rejected_finding'` rows whose `factText` starts with
   `[fp:<fp>]` — so suppression starts taking effect immediately,
   even for findings the LLM happens to re-emit.
3. `review_eval_event.dropped_by_feedback` (Phase 2) starts surfacing
   non-zero counts, which is the observable proof the closed-loop is
   working.
