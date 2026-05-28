# CodeCommit Web Embedded Auto-Setup (and server worker JobHandler)

> Design spec for connecting AWS CodeCommit repositories from the
> self-hosted operator console with a single web action, plus the
> foundational server-side worker `JobHandler` that has to exist for
> any platform's webhook → review pipeline to run end-to-end.
>
> This is the **shippable design**. The "current state" findings in §3
> are the blocker analysis that motivated splitting this out of
> [`review-agent-spec.md`](./review-agent-spec.md) §8.4.

## 1. Status

- **Draft (proposed).**
- **Owner**: _unset_.
- **Tracking issue**: _unset — will be filed before implementation._
- **Depends on**: **B0 blocker** — server worker `JobHandler`
  implementation. Covered in this same spec (§7) because nothing
  downstream (CodeCommit web embedded, GitHub Server-mode end-to-end)
  works without it.
- **Supersedes / updates**: [`review-agent-spec.md`](./review-agent-spec.md)
  §8.4. That section keeps the IAM minimum-set + `/feedback` allowlist
  rules; this spec adds the web-embedded provisioning surface and the
  per-repo allowlist migration path on top.

## 2. Motivation

Today the only way to point `review-agent` at an AWS CodeCommit repo is:

1. operator manually creates an SNS topic in the AWS console,
2. manually creates an EventBridge rule with the right event pattern,
3. manually wires the rule → topic target,
4. manually subscribes the server `/webhook/codecommit` HTTPS endpoint,
5. manually confirms the subscription,
6. adds the topic ARN to the comma-separated
   `REVIEW_AGENT_SNS_TOPIC_ARNS` env, **and**
7. inserts a row in `repos` with the right `platform` / `name` /
   `installationId`.

Six of those seven steps are external state the operator has to keep
in sync with one DB row by hand, which is the kind of friction this
project explicitly exists to avoid. The user-facing ask is simply
"connect this CodeCommit repo" — the same one-action shape we
already deliver for GitHub via the GitHub App install flow.

Beyond the UX, the manual flow has two operational sharp edges:

- **No teardown story.** Removing a `repos` row leaves the SNS topic
  and EventBridge rule live, which keeps producing SQS load for a
  webhook that will be rejected. Web-driven teardown closes the loop.
- **Webhook allowlist drift.** `REVIEW_AGENT_SNS_TOPIC_ARNS` is the
  only authn-style gate on the webhook (SNS signature verification
  aside). Operators silently desync env CSV from `repos` rows.

The Server-mode webhook → SQS path already lands jobs correctly
(`/webhook/codecommit` handler is fully implemented, see §3), so the
remaining cost is finishing the SDK calls + a DB schema bump + UI.

## 3. Phase A: current-state findings

Findings below are from a read-only Phase A investigation of the
working tree on `develop` at the time this spec was drafted. Every
claim is anchored to `file_path:line_number` so it is replayable.

### 3.1 `platform-codecommit` adapter API surface (implemented)

`packages/platform-codecommit/src/adapter.ts`:

| Capability | AWS SDK command | Source |
|---|---|---|
| `getPR` | `GetPullRequestCommand` | L130–136 |
| `getDiff` (paginated, `sinceSha` supported) | `GetDifferencesCommand` | L170–189 |
| `getFile` | `GetFileCommand` | L195–202 |
| `getExistingComments` / `listCodeCommitCommentsForPullRequest` | `GetCommentsForPullRequestCommand` | L327–345, L453–491 |
| `postReview` / `postSummary` | `PostCommentForPullRequestCommand` | L226–254, L311–322 |
| `applyApprovalState` | `UpdatePullRequestApprovalStateCommand` | L276–307 |
| `listCodeCommitPullRequestIds` | `ListPullRequestsCommand` | L515–553 |

**No `AssumeRole` support.** The adapter uses the AWS SDK default
credential chain directly (`adapter.ts:127`). Cross-account is out of
scope here (§16).

### 3.2 Webhook handler (implemented)

`packages/server/src/handlers/codecommit-webhook.ts`:

| Detail-type / message | Maps to | Source |
|---|---|---|
| `pullRequestCreated` | `pull_request.opened` | L106, L272–276 |
| `pullRequestSourceBranchUpdated` | `pull_request.synchronize` | L107–112, L279–283 |
| `pullRequestSourceReferenceUpdated` | `pull_request.synchronize` | L109–111 |
| `commentOnPullRequest` (`/feedback`, `@review-agent review`) | `issue_comment.created` | L286–307 |
| `SubscriptionConfirmation` / `UnsubscribeConfirmation` | auto HTTP GET to `SubscribeURL` | L231–245 |

The handler enqueues `JobMessage` records onto SQS. End of pipeline
on the producer side. The producer side is **complete**.

### 3.3 Queue → worker (BLOCKER)

`packages/server/src/lambda-worker.ts:22–43` is the SQS Lambda entry
point. It accepts `SQSEvent`, deserializes records, and **has no
`JobHandler` body**. Nothing reads the `JobMessage`, looks up the
repo, dispatches to the VCS adapter, or calls `runReview`. This is
the single blocker between "webhook arrives" and "review posted" for
**every** Server-mode platform, not just CodeCommit.

This is why the same backlog item gets folded into this spec rather
than filed separately: CodeCommit web embedded cannot ship without it,
and GitHub Server-mode end-to-end cannot ship without it.

### 3.4 `review_state` table (ready to use)

`packages/core/src/db/schema/review-state.ts:14–36` defines the
existing table. Relevant columns:

- `lastReviewedSha` — head SHA last reviewed for this PR.
- `baseSha` — base SHA at last review (used for rebase detection).
- `commentFingerprints` — dedup set already used by the GitHub Action.

No schema changes needed for incremental review. The runner middleware
already reads/writes via the `previousState` parameter.

### 3.5 Incremental-review wiring (partial)

- **GitHub Action**: complete. `packages/action/src/run.ts:105–179`
  reads `previousState`, computes `sinceSha`, calls
  `getDiff(ref, { sinceSha })`, and writes back.
- **CLI**: partial. `packages/cli/src/commands/review.ts:83–128`
  fetches `previousState` but does not currently forward `sinceSha`
  to the adapter.
- **Runner**: ready. `packages/runner/src/agent.ts:150–155` already
  forwards `incrementalSinceSha` into `composeSystemPrompt` when
  `incrementalContext: true`.
- **Server worker**: not wired (because §3.3).

### 3.6 Webhook allowlist mechanism (env-only today)

The webhook handler validates the inbound SNS topic ARN against
`REVIEW_AGENT_SNS_TOPIC_ARNS` (CSV env). There is no per-repo DB
table holding the topic ARN, so the env is the only mapping between
"infrastructure that exists in AWS" and "repos this server reviews".

### 3.7 Summary of blocker / non-blocker

| Layer | State | Action in this spec |
|---|---|---|
| `platform-codecommit` adapter | ready | none (already complete) |
| webhook ingress | ready | reuse |
| SQS queue | ready | reuse |
| **server worker `JobHandler`** | **missing** | **build (§7)** |
| `review_state` table | ready | reuse, with rebase rule (§7) |
| AWS resource provisioning | manual | replace with web flow (§8) |
| webhook allowlist | env CSV only | extend to DB-or-env (§10) |
| web UI for CodeCommit | absent | add (§11) |

## 4. Goals / Non-goals

### 4.1 Goals

- Operator can connect a CodeCommit repo from the web UI with a
  single form submission. Server performs all AWS-side provisioning
  (SNS topic + EventBridge rule + subscription) under its own runtime
  IAM role.
- **PR-created**: full source-vs-destination diff is reviewed
  (matches GitHub Action behavior on `opened`).
- **Subsequent push**: only the diff from
  `review_state.lastReviewedSha` to the current `sourceCommit` is
  reviewed.
- **Rebase detection**: if the current `baseCommit` differs from the
  saved `review_state.baseSha`, fall back to a full review (the
  incremental diff is no longer well-defined).
- **Teardown**: operator can delete the repo from the web UI; server
  removes the EventBridge target/rule and SNS subscription/topic
  before soft-deleting the DB row.
- Server worker `JobHandler` exists as a platform-agnostic foundation
  that GitHub Server-mode also benefits from.

### 4.2 Non-goals

- `AssumeRole` / cross-account topology. The server's runtime role
  must be in the same AWS account as the CodeCommit repo. (Future
  issue.)
- Polling mode (`ListPullRequests` loop) as an alternative to SNS.
  Out of scope here; the recovery CLI already covers disaster
  recovery (#110/#113).
- Multi-tenant SaaS. Self-hosted single-tenant assumed throughout.
- Other AWS services (S3 events, CodePipeline, ECR scan notifications,
  etc.).
- AWS console deeplinks / IAM policy generators in the UI. Operators
  copy the policy JSON from the docs (§12).

## 5. Architecture overview

```
┌───────────────┐     POST /api/repos              ┌────────────────────┐
│  Operator     │ ───────────────────────────────► │   server (Hono)    │
│  Web browser  │ ◄─────────── 201 Created ─────── │  process: API      │
└───────────────┘                                  └─────────┬──────────┘
                                                             │
                                          AWS SDK calls under │
                                          server runtime role │
                                                             ▼
                                              ┌──────────────────────────┐
                                              │  SNS topic               │
                                              │  EventBridge rule + tgt  │
                                              │  HTTPS subscription      │
                                              │  (auto-confirmed)        │
                                              └──────────┬───────────────┘
                                                         │ CodeCommit events
                                                         ▼
┌────────────────┐     CodeCommit PR event       ┌──────────────────────┐
│   AWS          │ ────────────────────────────► │ server /webhook/     │
│   CodeCommit   │                               │  codecommit          │
└────────────────┘                               └──────────┬───────────┘
                                                            │ enqueue
                                                            ▼
                                                       ┌─────────┐
                                                       │  SQS    │
                                                       └────┬────┘
                                                            │ SQS event
                                                            ▼
                                              ┌──────────────────────────┐
                                              │  server worker Lambda    │
                                              │  JobHandler (§7)         │
                                              │   ├─ repos lookup        │
                                              │   ├─ VCS adapter         │
                                              │   ├─ review_state lookup │
                                              │   ├─ runReview           │
                                              │   ├─ postReview          │
                                              │   └─ review_state upsert │
                                              └──────────────────────────┘
```

## 6. Data model

### 6.1 `repos` table additions

Add the following nullable columns to the existing `repos` table.
**Nullable** so existing GitHub rows and existing CodeCommit rows
configured the old way are not broken by the migration.

| Column | Type | Notes |
|---|---|---|
| `aws_region` | `text NULL` | e.g. `ap-northeast-1`. CodeCommit only. |
| `sns_topic_arn` | `text NULL` | Created by server. Drives webhook allowlist (§10). |
| `eventbridge_rule_arn` | `text NULL` | Created by server. Used for teardown. |
| `setup_status` | `text NULL` | `pending` / `configuring` / `ready` / `failed` (§6.3). |
| `setup_error` | `text NULL` | Last-known error message when `setup_status='failed'`. |

Existing columns (`platform`, `installationId`, `name`, `enabled`,
`deletedAt`, etc.) are unchanged.

**Migration**: operator runs `drizzle-kit generate` after the schema
change lands. Migration file path follows the existing `db/migrations/`
numbering. No data backfill is required (all-NULL is a valid starting
state for both old GitHub rows and old manually-provisioned CodeCommit
rows).

### 6.2 `review_state` usage

Existing table, no schema change.

- Worker writes `lastReviewedSha`, `baseSha`, and `commentFingerprints`
  on successful review (same fields the GitHub Action already
  populates).
- Worker reads them on the next event to compute incremental diff
  and detect rebases.
- Rows are keyed by `(installationId, repo, prId)` already.

**Behavioral change**: today only the GitHub Action writes
`review_state` for live runs. After this spec ships, the server
worker writes it for **both** GitHub Server-mode and CodeCommit. The
write shape is identical; operators with existing GitHub
Server-mode installations will simply start seeing rows that were
previously absent. No reconciliation needed because the GitHub Action
path is unchanged.

### 6.3 `setup_status` state machine

```
                       POST /api/repos
                              │
                              ▼
                       ┌─────────────┐
                       │ configuring │
                       └─────┬───────┘
                             │
        ┌────────────────────┴────────────────────┐
        │                                         │
   AWS calls all OK                          any step fails
        │                                         │
        ▼                                         ▼
   ┌─────────┐                              ┌──────────┐
   │  ready  │◄──── re-test connection ◄──  │  failed  │
   └────┬────┘   (UI button or operator)    └────┬─────┘
        │                                         │
        │   DELETE /api/repos/:id                 │   DELETE /api/repos/:id
        ▼                                         ▼
   teardown AWS                              teardown AWS (best effort)
        │                                         │
        ▼                                         ▼
   soft-delete row                          soft-delete row
```

- `pending` is reserved for future async flows (§8.4) and not used in
  the synchronous v1 path.
- Re-test from `failed` retries provisioning idempotently. SNS
  `CreateTopic` is naturally idempotent (returns the same ARN); EB
  `PutRule` / `PutTargets` likewise upsert by name. `Subscribe`
  returns the existing subscription ARN when already subscribed.
- Failed teardown leaves the row in `failed` state, not deleted, so
  the operator sees the residual and can retry.

## 7. JobHandler design (server worker, platform-agnostic foundation)

The `JobHandler` is the missing piece in §3.3. It is platform-agnostic
on purpose: GitHub Server-mode and CodeCommit both deliver the same
`JobMessage` shape to SQS, and both need the same downstream pipeline.

### 7.1 `JobMessage` receive

- SQS Lambda entry deserializes each record's body to `JobMessage`
  (existing Zod schema in `packages/core/src/queue/`).
- Per-record try/catch so a poison message in batch position N does
  not poison N+1.
- On unrecoverable parse error → record-level failure response so SQS
  routes the record to DLQ.

### 7.2 `repos` lookup + enabled/deleted guard

- Look up `repos` by `(installationId, name)` (or `(platform, name)`
  per existing keying, whichever the table uses today).
- If row missing → log + no-op + ack (we did get an event for a repo
  we have not provisioned in `repos`; ignoring is correct).
- If `repos.deletedAt IS NOT NULL` → log + no-op + ack.
- If `repos.enabled = false` → log + no-op + ack.
- If `setup_status NOT IN ('ready', NULL)` (CodeCommit case) → log +
  no-op + ack (cannot review during provisioning / failed setup).

### 7.3 Platform detection + VCS adapter instantiation

- Branch on `repos.platform`:
  - `github` → `platform-github` adapter with installation token.
  - `codecommit` → `platform-codecommit` adapter under the worker's
    AWS credentials. `awsRegion` passed from `repos.aws_region`.
- Wrap in the same `VCS` interface so the rest of this handler is
  platform-free.

### 7.4 `review_state` lookup + diff strategy

| `review_state` row | PR `baseCommit` | Diff strategy |
|---|---|---|
| absent | — | full source-vs-destination |
| present | matches saved `baseSha` | incremental from `lastReviewedSha` |
| present | differs from saved `baseSha` | fall back to full (rebase) |
| any state, repo `deletedAt` set | — | no-op |
| any state, repo `enabled=false` | — | no-op |

Rationale for the rebase rule: once the base moves, `lastReviewedSha`
is no longer reachable from the new diff in a meaningful way, so any
"changes since X" semantics are misleading. Full re-review keeps the
inline comments accurate, at the cost of one rerun.

### 7.5 `runReview` invocation

- Construct the `RunReviewInput` per the existing runner contract
  (`packages/runner/src/agent.ts`).
- For incremental:
  - `incrementalContext: true`
  - `incrementalSinceSha: review_state.lastReviewedSha`
  - `getDiff(ref, { sinceSha })` on the adapter
- For full:
  - `incrementalContext: false`
  - regular `getDiff(ref)`
- All other inputs (config, language, comment-fingerprint dedup set,
  base prompt) are platform-agnostic.

### 7.6 `postReview` / approval / `commentFingerprints` update

- After `runReview` returns the `ReviewOutput`, dispatch to the
  adapter's `postReview` and (if configured) `applyApprovalState`.
- Compute the new `commentFingerprints` set (union of previous +
  newly-posted) and stage it for the `review_state` upsert.

### 7.7 `review_state` upsert

- Single upsert keyed by `(installationId, repo, prId)`.
- Fields:
  - `lastReviewedSha` ← current `sourceCommit`
  - `baseSha` ← current `baseCommit`
  - `commentFingerprints` ← updated set
  - `updatedAt` ← `now()`
- Same code path for full and incremental — the only thing that
  changes is whether the prior row existed.

### 7.8 `review_eval_event` recording

- Emit one `review_eval_event` row per invocation with `cost_usd`,
  `duration_ms`, `tokens_in`, `tokens_out`, `model`, `platform`,
  `incremental` flag. Identical schema to GitHub Action runs so the
  SQL playbook (`docs/operations/review-eval-event-playbook.md`)
  works unchanged.

### 7.9 Error handling

- **LLM provider 5xx / rate limit** → throw, let SQS retry (per
  existing `maxReceiveCount` config). DLQ after attempts exhausted.
- **VCS adapter 403 / 404** → log structured error, ack the record
  (do not retry; the cause is not transient).
- **`postReview` partial failure** (e.g. inline comments posted but
  summary failed) → record what was posted in `commentFingerprints`
  and let the next retry only re-post the missing piece. Idempotent
  by fingerprint.
- **`review_state` upsert failure** → throw and retry; the worst case
  is duplicate posts on retry, which the fingerprint dedup already
  handles.
- **No-op acks** (disabled / deleted / unknown repo) are logged at
  `info` with structured fields so SLO playbook queries still work.

## 8. Web embedded auto-setup flow (`POST /api/repos`)

### 8.1 Request shape

```ts
POST /api/repos
Content-Type: application/json

{
  "platform": "codecommit",
  "name": "<repo-name>",
  "awsRegion": "<region>",          // e.g. "ap-northeast-1"
  "installationId": "<aws-account-id-or-tenant-key>"
}
```

GitHub keeps its existing shape (no `awsRegion`, no provisioning
side-effects). The handler branches on `platform`.

### 8.2 Server-side steps (CodeCommit branch)

1. `INSERT INTO repos (..., setup_status='configuring', ...)` — get
   the new `id`.
2. AWS SDK: `sns:CreateTopic` with a deterministic name
   (`review-agent-{installationId}-{repoName}`). Capture the topic
   ARN.
3. AWS SDK: `events:PutRule` — source `aws.codecommit`, event
   pattern matching this repo by name, in the requested region.
4. AWS SDK: `events:PutTargets` — target = the SNS topic ARN from
   step 2.
5. AWS SDK: `sns:Subscribe` — protocol `https`, endpoint =
   the server's public `/webhook/codecommit` URL.
6. Server's webhook handler receives `SubscriptionConfirmation` and
   auto-confirms via the existing handler path
   (`codecommit-webhook.ts:231–245`). The synchronous POST handler
   short-polls Postgres / in-memory marker until confirmation lands
   or 10s elapses (whichever first).
7. `UPDATE repos SET setup_status='ready', sns_topic_arn=…,
   eventbridge_rule_arn=…, setup_error=NULL WHERE id=…`.
8. Respond `201 Created` with the full `RepoDetail` JSON.

### 8.3 Failure handling

- Any step throws → mark `setup_status='failed'`,
  `setup_error=<truncated message>`, and attempt best-effort
  teardown of resources created so far (reverse order: remove EB
  target, delete rule, unsubscribe, delete topic).
- Response: `5xx` with structured JSON `{ code, message, retryable }`.
- If teardown itself partially fails, the row stays `failed` and the
  operator must run the UI "Re-test connection" or "Delete" action.

### 8.4 Synchronous vs asynchronous

**v1: synchronous.** Provisioning typically takes ~5–15s. POST
returns when all AWS calls plus subscription confirmation complete.
The request times out at **30s**; if it does, the client polls
`GET /api/repos/:id` to observe the final `setup_status`.

Async (SSE / job-record) is deferred (§16). The reservoir column
`setup_status='pending'` exists for that future path.

## 9. Teardown flow (`DELETE /api/repos/:id`, platform=codecommit)

1. Look up the row. If missing or already `deletedAt IS NOT NULL` →
   `204`.
2. If `setup_status='ready'`, run in this order:
   1. `events:RemoveTargets` — remove the SNS target.
   2. `events:DeleteRule` — delete the rule.
   3. `sns:Unsubscribe` — remove the HTTPS subscription.
   4. `sns:DeleteTopic` — delete the topic.
3. If `setup_status='failed'`, attempt the same sequence on whichever
   ARNs are populated; tolerate `NotFound` errors.
4. On all-success → `UPDATE repos SET deletedAt=now(),
   setup_status='ready'` (or just clear). Respond `204`.
5. On partial failure → `UPDATE repos SET setup_status='failed',
   setup_error='teardown: …'`. Respond `5xx`. Operator retries via UI.

The DB row is **never hard-deleted** so historical
`review_eval_event` and `review_state` rows keep their FK targets
(if FKs exist) / their logical reference.

## 10. Webhook allowlist migration

### 10.1 Current behavior

`REVIEW_AGENT_SNS_TOPIC_ARNS` env (CSV). Webhook rejects ARNs not in
the list.

### 10.2 New behavior

The webhook accepts an inbound topic ARN if **either**:

- `SELECT 1 FROM repos WHERE sns_topic_arn = ? AND deletedAt IS NULL AND enabled = true` returns a row, **OR**
- the ARN appears in `REVIEW_AGENT_SNS_TOPIC_ARNS` env (CSV, legacy).

The DB lookup is the primary path for any repo provisioned by the new
web flow. The env CSV remains as a transition shim for operators who
have manually-provisioned topics referenced in §2.

### 10.3 Deprecation timeline

- v1.x: both paths supported (this spec).
- v1.x + N: env CSV path emits a deprecation warning on startup if
  any entry is **not** also present in `repos.sns_topic_arn`.
- v2: env CSV path removed. Operators with manual setups run a
  one-shot CLI to backfill `repos.sns_topic_arn` for those rows
  (filed as a separate issue at that time).

## 11. Web UI changes

### 11.1 `repos-new.tsx` (new-repo form)

- Existing GitHub form unchanged.
- When `platform` is `codecommit`:
  - Show `awsRegion` select (preset list: `ap-northeast-1`,
    `us-east-1`, `us-west-2`, `eu-central-1`, `eu-west-1` — extendable
    via config).
  - Show "Auto-setup AWS resources" checkbox, default **on** and
    currently required (manual mode is the legacy path documented in
    §10 — there is no UI for it).
  - Show a progress indicator with the four steps:
    "Creating SNS topic…" → "Creating EventBridge rule…" →
    "Subscribing webhook…" → "Confirming subscription…" → "Done".
  - The form is `disabled` while the POST is in flight.
- On `5xx`, render the `setup_error` from the response JSON.

### 11.2 `integrations.tsx`

- CodeCommit card today shows: configured / region.
- Add: "Auto-setup capable" badge driven by a server-side IAM probe
  (the server calls `sts:GetCallerIdentity` + a dry-run of each
  required action with `IAM` simulator if available, or simply
  reports the configured role ARN and lets the operator verify the
  policy attachment matches §12).

### 11.3 `repo-detail.tsx`

For `platform=codecommit` rows, show:

- `SNS Topic ARN` (copy button).
- `EventBridge Rule ARN` (copy button).
- `setup_status` badge (`ready` green / `failed` red / `configuring`
  amber). On `failed`, display `setup_error` inline.
- **"Re-test connection"** button → server hits `codecommit:GetRepository`,
  returns OK / specific error.
- **"Delete"** button → calls the teardown flow in §9.

## 12. IAM requirements

The server runtime role needs the following actions. This is a
**superset** of the §8.4 CodeCommit IAM minimum — that minimum is the
worker-side action list; web-embedded provisioning adds the
SNS + EventBridge actions.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "CodeCommitReadAndComment",
      "Effect": "Allow",
      "Action": [
        "codecommit:GetPullRequest",
        "codecommit:GetDifferences",
        "codecommit:GetFile",
        "codecommit:GetCommentsForPullRequest",
        "codecommit:PostCommentForPullRequest",
        "codecommit:PostCommentReply",
        "codecommit:UpdatePullRequestApprovalState",
        "codecommit:ListPullRequests",
        "codecommit:GetRepository"
      ],
      "Resource": "arn:aws:codecommit:*:*:*"
    },
    {
      "Sid": "SnsProvisioning",
      "Effect": "Allow",
      "Action": [
        "sns:CreateTopic",
        "sns:DeleteTopic",
        "sns:Subscribe",
        "sns:Unsubscribe",
        "sns:ListSubscriptionsByTopic",
        "sns:GetTopicAttributes"
      ],
      "Resource": "*"
    },
    {
      "Sid": "EventBridgeProvisioning",
      "Effect": "Allow",
      "Action": [
        "events:PutRule",
        "events:PutTargets",
        "events:DeleteRule",
        "events:RemoveTargets",
        "events:DescribeRule",
        "events:ListTargetsByRule"
      ],
      "Resource": "*"
    }
  ]
}
```

Operators who want to scope `Resource` further may restrict by
`arn:aws:sns:<region>:<acct>:review-agent-*` and the equivalent
EventBridge ARN prefix; the deterministic naming in §8.2 makes that
practical.

## 13. Acceptance criteria

- [ ] AC-1: `POST /api/repos` with valid CodeCommit payload returns
  `201` within 30s and `repos.setup_status='ready'`, with non-null
  `sns_topic_arn`, `eventbridge_rule_arn`, `aws_region`.
- [ ] AC-2: A CodeCommit `pullRequestCreated` event for that repo
  produces a full review (source vs destination diff) and writes
  `review_state` row with `lastReviewedSha` and `baseSha`.
- [ ] AC-3: A subsequent `pullRequestSourceBranchUpdated` event
  produces an incremental review (diff from saved `lastReviewedSha`)
  and **does not** re-post fingerprints already in
  `commentFingerprints`.
- [ ] AC-4: A `pullRequestSourceBranchUpdated` event after a rebase
  (current `baseCommit` ≠ saved `baseSha`) falls back to a full
  review.
- [ ] AC-5: `DELETE /api/repos/:id` removes the SNS subscription,
  topic, EventBridge target and rule in the listed order, then
  soft-deletes the row.
- [ ] AC-6: An IAM failure during `POST /api/repos` leaves
  `setup_status='failed'`, populates `setup_error`, and best-effort
  tears down any partially-created resource.
- [ ] AC-7: Webhook accepts requests whose topic ARN is present in
  `repos.sns_topic_arn` even when not in `REVIEW_AGENT_SNS_TOPIC_ARNS`.
- [ ] AC-8: Webhook still accepts ARNs in
  `REVIEW_AGENT_SNS_TOPIC_ARNS` for legacy manual setups.
- [ ] AC-9: Server worker `JobHandler` is invoked for GitHub
  Server-mode messages as well and writes the same `review_state`
  shape (verifies the platform-agnostic claim in §7).
- [ ] AC-10: `pnpm typecheck && pnpm lint && pnpm test:coverage &&
  pnpm build` green; per-package coverage thresholds met.

## 14. Implementation phases

| Phase | Scope | Estimate |
|---|---|---|
| **B0** | Server worker `JobHandler` (§7), platform-agnostic foundation | 3–4 person-days |
| **B1** | Wire incremental-review diff strategy + rebase fallback into the worker | 1 person-day |
| **C1.1** | DB schema additions (§6.1) + migration | 0.5 person-day |
| **C1.2** | AWS SDK expansion (SNS + EventBridge) in server | 1.5 person-days |
| **C1.3** | `POST` / `DELETE` `/api/repos` extensions (§8, §9) | 1 person-day |
| **C1.4** | Webhook allowlist DB-or-env lookup (§10) | 0.5 person-day |
| **C2** | Web UI changes (§11) | 3 person-days |
| **C3** | Operator docs + IAM policy sample (§12) | 0.5 person-day |
| **C4** | Tests (unit + integration across worker, API, webhook) | 2 person-days |

**Total: 13–14 person-days.** B0 is the critical-path blocker; B1
onward can be issued in parallel waves after B0 lands.

## 15. Risks / trade-offs

- **Runtime role has provisioning power.** The server can create and
  delete SNS topics + EventBridge rules in the same AWS account.
  Acceptable for self-hosted single-tenant; would be unacceptable for
  multi-tenant SaaS. Documented in §4.2 / §16.
- **EventBridge rule quota.** AWS default is 300 rules per account
  per bus. At 1 rule per repo, a single operator with 300+ repos hits
  the quota. Mitigation: deferred until the quota is hit; future
  issue could switch to a shared rule with multiplexed event pattern.
- **30s synchronous POST timeout.** Most CreateTopic / PutRule /
  Subscribe / confirm round-trips finish well under this, but
  long-tail AWS API latency could exceed it. Mitigation: the row is
  left in `configuring`; the operator polls `GET /api/repos/:id` and
  the next handler invocation completes the transition. (Effectively
  a degenerate version of the async path in §16.)
- **Allowlist migration is a breaking-change-shaped no-op for
  v1.x.** New repos work via DB; old setups keep working via env.
  Risk: operators forget to remove env entries after switching, and
  the deprecation warning (§10.3) only triggers in v1.x + N.
- **AWS SDK exceptions and resource leak.** Best-effort teardown on
  failure is not transactional. A repo can end up in `failed` with
  one or two real AWS resources still present. The UI surfaces this
  via `setup_error`; the Re-test / Delete buttons make the situation
  recoverable.
- **`review_state` write-side now includes CodeCommit.** Previously
  only the GitHub Action wrote to it for live runs. Existing
  operators with CodeCommit rows in `review_state` (only possible
  via the recovery CLI today) will see new live writes. Verify the
  schema can handle both write sources; expected to be a no-op since
  the columns match. Filed under AC-2/AC-3.

## 16. Out of scope (future work)

- `AssumeRole` / cross-account CodeCommit topology.
- Polling mode (server-driven `ListPullRequests` loop) as an
  alternative ingress.
- Multi-tenant SaaS hardening (per-tenant IAM role, tenant-scoped
  resource naming, billing).
- AWS console deeplink generation in the UI.
- Per-repo IAM role separation (each `repos` row uses a separate
  AssumeRole target).
- Async provisioning UX with SSE or job-records (the `pending`
  `setup_status` is a forward-compatibility hook for this).
- Shared EventBridge rule with multiplexed event pattern (rule-quota
  mitigation).

## 17. References

- Phase A current-state findings (§3) with file:line anchors.
- [`review-agent-spec.md`](./review-agent-spec.md) §8.4 — existing
  CodeCommit IAM minimum + `/feedback` allowlist rules. This spec
  updates §8.4 by reference; the worker-side rules there continue to
  apply.
- [`docs/operations/codecommit-disaster-recovery.md`](../operations/codecommit-disaster-recovery.md) —
  related disaster-recovery work (#110, #113) that informs the
  recovery side of the same allowlist mechanism (§10).
- [`docs/operations/review-eval-event-playbook.md`](../operations/review-eval-event-playbook.md) —
  SQL playbook that depends on `JobHandler` emitting the same
  `review_eval_event` shape across platforms (§7.8).
- [`packages/core/src/db/schema/review-state.ts`](../../packages/core/src/db/schema/review-state.ts) —
  existing `review_state` schema used unchanged.
- [`packages/runner/src/agent.ts`](../../packages/runner/src/agent.ts) —
  `incrementalContext` / `incrementalSinceSha` plumbing that the
  worker reuses.
