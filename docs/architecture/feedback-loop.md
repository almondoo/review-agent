# Feedback loop — `review_history` writer

Spec references: §7.6 (learned facts), v1.2 epic [#83](https://github.com/almondoo/review-agent/issues/83) Phase 3 ([#92](https://github.com/almondoo/review-agent/issues/92)), `/feedback` command ([#95](https://github.com/almondoo/review-agent/issues/95)).

## Signals collected

Phase 3 records **explicit** human feedback on the agent's inline
comments. The decision (epic #83 Open question Q2) is intentionally
narrow — LLM-based interpretation of free-text reply bodies is
deferred to a later issue. Three signals are recognised:

| Signal | Source webhook event | `factType` |
|---|---|---|
| `thumbs_up` | `reaction` / `pull_request_review_comment_reaction` with `content: '+1'` | `accepted_pattern` |
| `thumbs_down` | same family with `content: '-1'` | `rejected_finding` |
| `dismissed` | `pull_request_review` with `action: 'dismissed'` | `rejected_finding` |

Other reactions (`heart`, `laugh`, `eyes`, etc.) are noise and the
receiver drops them. Only `action: 'created'` reactions count — a
later `delete` or `edit` does not undo the previously-recorded row.

## Receiver-side flow

```
GitHub webhook
    │
    ▼
handleWebhook(...)             ← packages/server/src/handlers/webhook.ts
    │  classifies reaction / dismissed
    ▼
WebhookResult { kind: 'feedback', signal, commentId }
    │
    ▼
operator worker handler        ← user code in your Lambda / Fargate handler
    │  resolves commentId → fingerprint via your DB or GitHub API
    │  builds FeedbackEvent
    ▼
createFeedbackWriter(...)      ← packages/runner/src/feedback-writer.ts
    │  PII redact + rate-limit + factType mapping
    ▼
createReviewHistoryWriter(db)  ← packages/db/src/review-history.ts
    │
    ▼
review_history table (Postgres)
```

The receiver intentionally does **not** enqueue feedback into the
review-job queue — the existing `JobMessage` shape is for review
runs, not feedback writes. Operators wire feedback through a
separate code path (typically a thin async handler in the same
Lambda).

## Writer guarantees (`createFeedbackWriter`)

| Concern | Behaviour |
|---|---|
| PII / secret leakage | `factText` is scanned with the same gitleaks built-in ruleset as the review path. Matches are replaced with `[REDACTED:<ruleId>]` before insert. Operator-supplied `privacy.redact_patterns` extend the rule set; invalid regexes are silently dropped (matching the runtime behavior). |
| Rate-limit | Default 10 writes per writer instance. Excess events are dropped and reported via the optional `onRateLimit` hook. Operators construct **one writer per job** so the cap scopes correctly. |
| Fact-type discriminator | `feedbackKindToFactType` is the single source of truth: `'thumbs_up'` → `'accepted_pattern'`; `'thumbs_down'` / `'dismissed'` → `'rejected_finding'`. Phase 4's reader uses the same function on the way out. |
| Fingerprint linkage | The writer prefixes `factText` with `[fp:<fingerprint>]` so Phase 4 can route facts to the matching comment fingerprint without a new DB column. |
| TTL | The schema's `expires_at` default is `now() + 180 days`. The writer does not touch it. Pruning is a separate concern — see `pruneExpiredReviewHistory` in `@review-agent/db`. |

## Example operator wiring

```ts
import { createFeedbackWriter } from '@review-agent/runner';
import { createReviewHistoryWriter, createDbClient, withTenant } from '@review-agent/db';

const db = createDbClient({ url: process.env.DATABASE_URL });
const historyWriter = createReviewHistoryWriter(db);

async function onReactionWebhook(result: WebhookResult, payload: GitHubReactionPayload) {
  if (result.kind !== 'feedback') return;
  const fingerprint = await resolveCommentFingerprint(payload);
  if (!fingerprint) return; // not one of our comments

  const writer = createFeedbackWriter({
    writer: historyWriter,
    redactPatterns: reviewerConfig.privacy.redact_patterns,
    onRateLimit: (ev) => log.warn({ ev }, 'feedback rate limit hit'),
  });

  await withTenant(installationId, async () => {
    await writer.record({
      installationId,
      repo: `${payload.repository.owner.login}/${payload.repository.name}`,
      prNumber: payload.pull_request.number,
      fingerprint,
      kind: result.signal,
      factText: payload.reaction.user.login + ' reacted ' + payload.reaction.content,
      occurredAt: new Date(payload.reaction.created_at),
    });
  });
}
```

## CodeCommit path

CodeCommit has no reaction API and no `pull_request_review.dismissed`
equivalent — there is **no implicit signal** the reviewer can emit
that maps cleanly onto `thumbs_up` / `thumbs_down` / `dismissed`. To
keep CodeCommit tenants from running with the feedback writer
permanently disabled, v1.2 #95 introduces an **explicit `/feedback`
comment command** as the CodeCommit replacement (and as a fallback
on GitHub for users who prefer typed commands).

### Command syntax

| Comment body | `FeedbackKind` | Notes |
|---|---|---|
| `/feedback accept` | `thumbs_up` | Reply on a bot comment whose body carries a `<!-- fingerprint:<fp> -->` marker (writer: #96, see [Fingerprint embedding format](#fingerprint-embedding-format)). |
| `/feedback reject` | `thumbs_down` | Same. Marker-based path. |
| `/feedback accept <fp_prefix>` | `thumbs_up` | Argument path. `<fp_prefix>` must be `[0-9a-f]{8,}` and prefix-match exactly one entry in `review_state.commentFingerprints`. |
| `/feedback reject <fp_prefix>` | `thumbs_down` | Same. Argument path. |
| `/feedback dismiss` | `dismissed` | PR-level comment — targets the summary review by id, not an inline comment. |

The command parser (`parseFeedbackCommand` in
`packages/server/src/utils/parse-command.ts`) is case-insensitive on
the subcommand and validates `<fp_prefix>` as **at least 8 lowercase
hex characters**. Shorter / non-hex prefixes fail parsing and are
treated as ignored noise rather than malformed `/feedback`.

`/feedback` is recognised on **both** platforms:

- **GitHub**: in `issue_comment`, `pull_request_review`, and
  `pull_request_review_comment` event bodies. The reaction-based
  path (👍 / 👎) remains the primary signal — `/feedback` is a
  fallback.
- **CodeCommit**: in `commentOnPullRequest` event bodies. This is the
  **only** path on CodeCommit.

### Permission guard

`/feedback` writes into `review_history`, which the runner re-injects
on subsequent reviews as `<learned_facts>`. An attacker who can
comment on PRs but cannot push to the repo therefore has a low-cost
path to poison future outputs unless we gate the command on **write
permission** to the repository.

Per-platform guard:

| Platform | Check | Failure mode |
|---|---|---|
| GitHub | `octokit.rest.repos.getCollaboratorPermissionLevel({owner, repo, username})` → `permission ∈ {'admin', 'maintain', 'write'}`. Wired via `AppDeps.checkGithubFeedbackAuthz`. | Silently ignored (no PR reply). Logged + counter `outcome: 'unauthorized'`. |
| CodeCommit | CSV allowlist in `REVIEW_AGENT_FEEDBACK_ALLOWLIST` env (or `AppDeps.codecommitFeedbackAllowlistEnv` override). Matched against the SNS event's `userIdentity.principalId`. | Silently ignored. Empty / unset env → fail-closed (every `/feedback` denied). |

The guards intentionally **never** post a reply on the PR explaining
why a command was ignored — that would let any unauthenticated
visitor force the bot to comment by spamming `/feedback`, creating a
comment-forward DoS vector. See `docs/security/feedback-command-authz.md`.

### Fingerprint resolution

The webhook receiver does **not** itself resolve the targeted
fingerprint — it forwards the optional `<fp_prefix>` argument to the
worker, which has the DB connection needed to read
`review_state.commentFingerprints`. The resolver
(`resolveFingerprint` in `packages/runner/src/feedback-fingerprint-resolver.ts`)
runs in the worker with this precedence:

1. **`<!-- fingerprint:<fp> -->` marker** on the parent (bot) comment
   body. Matches a known fingerprint → success.
2. **`<fp_prefix>` argument** prefix-match against
   `commentFingerprints`. Unique hit → success. 2+ matches →
   `ambiguous_prefix`. 0 matches → `no_match`.
3. Otherwise → `no_marker_and_no_prefix`.

### Fingerprint embedding format

(Writer: #96 — `packages/platform-github/src/adapter.ts` and
`packages/platform-codecommit/src/adapter.ts` `postReview`.)

Every inline comment the bot posts has the following marker appended
to its body so the (1) resolver path above can recover the fingerprint
without a DB lookup:

```
<finding body>

<!-- fingerprint:<16-hex> -->
```

- `<16-hex>` is the 16-character `fingerprint()` output from
  `packages/core/src/fingerprint.ts`. The full value is embedded so
  the resolver's exact-match path against
  `review_state.commentFingerprints` succeeds without prefix logic.
- The marker is added via `appendFingerprintMarker()` from
  `@review-agent/core` — both adapters use the same helper to keep the
  format identical (regex `/<!--\s*fingerprint:([0-9a-f]{8,16})\s*-->/i`
  in `extractFingerprintFromComment`).
- `appendFingerprintMarker` is **idempotent** — passing the same
  fingerprint twice does not produce duplicate markers. This makes
  re-posts safe.
- The marker is rendered as a hidden HTML comment on both platforms
  (GitHub Markdown and CodeCommit Markdown both swallow it on render),
  so the end-user view is unchanged.

**Back-compat**: posted comments created **before** #96 shipped have
no marker. `/feedback` on those comments falls back to path (2)
(`<fp_prefix>` argument) automatically — that is the v1.2 #95 design.
Operators do not need to repost the historical comments.

### Receiver-side flow (extended)

```
GitHub webhook              CodeCommit SNS
    │                              │
    ▼                              ▼
handleWebhook(...)        handleCodecommitWebhook(...)
    │  parseFeedbackCommand        │  parseFeedbackCommand
    │  checkGithubFeedbackAuthz    │  checkCodeCommitFeedbackAuthz
    ▼                              ▼
WebhookResult { kind: 'feedback_command', signal, outcome, fpPrefix?, prNumber }
    │
    ▼
operator worker handler
    │  loads review_state.commentFingerprints
    │  resolveFingerprint(...)
    │  builds FeedbackEvent (when ok)
    ▼
createFeedbackWriter(...)
    │  PII redact + rate-limit + factType mapping
    ▼
createReviewHistoryWriter(db) → review_history
```

The receiver-side handler returns one of four outcome labels via the
`review_agent_feedback_command_total{platform, kind, outcome}` counter:

- `recorded` — authz passed, worker should attempt the write.
- `unauthorized` — permission check failed (or no checker wired).
- `unresolved` — PR fields missing; worker also surfaces this when
  fingerprint resolution returns `no_match` / `ambiguous_prefix` /
  `no_marker_and_no_prefix` via `recordFeedbackCommandOutcome`.
- `rate_limited` — writer's per-job cap dropped the write; the worker
  re-labels via `recordFeedbackCommandOutcome` when
  `createFeedbackWriter.record` returns `{ dropped: true }`.

### Failure semantics

All `/feedback` paths return HTTP **200** to the platform — including
`unauthorized`, `unresolved`, and `rate_limited`. This is intentional:
returning non-2xx to GitHub / SNS would invite retry storms on a
signal that is **best-effort** by design (the next review still runs
fine without the feedback row).

## Out of scope (deferred to later issues)

- **LLM-based comment-reply interpretation** (epic #83 Q2). "thanks,
  fixed!" / "this is a false positive" responses are not classified
  by Phase 3.
- **Accepted-pattern collection beyond 👍** (Q3). Two other signals
  considered (N-PRs-without-dismiss, suggestion adopted into a
  commit) are deferred.
- **GraphQL Resolve conversation state**. REST cannot fetch the
  resolved-vs-open state of a conversation, so it is not consulted.
- **GitHub draft review `/feedback`** — draft reviews are not yet
  submitted, so they carry no fingerprint. The command parser
  recognises them but the receiver returns `unresolved`.
- **CodeCommit `Resolved` state** — CodeCommit has no equivalent
  concept; `/feedback dismiss` is the only "this is wrong" signal.
- **Chained `/feedback` replies** — `/feedback` posted as a reply to
  another `/feedback` reply (rather than the bot comment) is not
  recognised; nested resolution is a future issue.
- **IAM `simulate-principal-policy` for CodeCommit** — the initial
  release uses a CSV allowlist; a future iteration can replace it
  with `codecommit:GitPush` simulation against the principal once
  STS / IAM trust paths are settled in production deployments.

## Worked-example handler

For a full end-to-end worker that wires the writer, reader, recorder,
adapters, OTel bridges, and both cleanup electors together, see
[`docs/operations/v1-2-worker-example.md`](../operations/v1-2-worker-example.md).
