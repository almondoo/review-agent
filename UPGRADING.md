# Upgrading

`review-agent` follows [Semantic Versioning](https://semver.org/) from
**v1.0.0 onwards**. This document declares which surfaces are part of
the public API (and therefore protected by SemVer), which surfaces are
internal (and may change between any two patch releases), and how to
migrate across breaking version bumps.

Pre-v1.0 releases (`0.x`) are not SemVer-stable — `0.1` → `0.2` and
`0.2` → `0.3` shipped breaking changes routinely. v1.0 freezes the
public API; subsequent breaking changes require a major bump and a
matching `## From X.y → Z.0` section below.

---

## SemVer commitment

| Bump | Allowed in | Example |
|---|---|---|
| Patch (`1.0.0 → 1.0.1`) | Bug fixes that preserve behaviour. Internal refactors. Documentation. Dependency bumps that don't change the public API surface. | Fix a regex in the gitleaks scanner, retry tweak in the LLM driver. |
| Minor (`1.0.0 → 1.1.0`) | Backwards-compatible additions: new optional config fields, new optional `LlmProvider` capabilities, new CLI subcommands, new exports from a public package. | Add `coordination.other_bots: defer_if_present`, add a new provider driver. |
| Major (`1.0.0 → 2.0.0`) | Backwards-incompatible changes to anything in the **public API surface** below. Always accompanied by a new `## From 1.y → 2.0` section. | Rename `runReview()` arguments, change the `.review-agent.yml` `version: 1` schema, drop a provider driver. |

Provider-specific behaviour changes that originate **upstream** (e.g.
Anthropic deprecating `claude-sonnet-4-5`) are documented in the
release notes but do not trigger a major bump on their own. We track
the upstream change and adjust pricing tables, default models, and
docs in a minor release.

---

## Public API surface

These are the surfaces that v1.0+ commits to maintain compatibility for.

### `@review-agent/core`

- All exported types from `packages/core/src/index.ts`:
  `VCS`, `PR`, `PRRef`, `Diff`, `DiffFile`, `CloneOpts`,
  `ExistingComment`, `GetDiffOpts`, `ReviewState`, `ReviewPayload`,
  `InlineComment`, `Severity`, `Side`, `CostLedgerRow`, `AuditRow`,
  `JobMessage`, `EncryptedPayload`, `KmsClient`, `BYOKProvider`,
  `ReviewAgentError` and subclasses.
- The Zod schemas: `ReviewOutputSchema`, `InlineCommentSchema`,
  `JobMessageSchema`. Schema-level breaking changes (a previously
  optional field becoming required, a removed enum case) are major.
- The `fingerprint(input)` function and its `FingerprintInput`
  contract — fingerprint stability is a hard guarantee because
  hidden state comments depend on it.
- The audit-log canonical-payload format and HMAC chain rule
  (`canonicalPayload`, `computeAuditHash`, `AUDIT_GENESIS_HASH`).

### `@review-agent/llm`

- The `LlmProvider` interface from `packages/llm/src/types.ts`:
  `name`, `model`, `generateReview`, `estimateCost`,
  `pricePerMillionTokens`, `classifyError`. Breaking changes to
  this shape force a major bump (every driver and the runner depend
  on it).
- The factory functions: `createAnthropicProvider`,
  `createOpenAIProvider`, `createAzureOpenAIProvider`,
  `createGoogleProvider`, `createVertexProvider`,
  `createBedrockProvider`, `createOpenAICompatibleProvider`. Their
  config object shape (`ProviderConfig`) is part of the public API.
- The pricing tables (`ANTHROPIC_PRICING`, `OPENAI_PRICING`, etc.)
  are exposed for operators that wrap them; rename / remove → major.

### `@review-agent/runner`

- `runReview(job, provider, deps?)` from `packages/runner/src/agent.ts`:
  the `ReviewJob` shape, the `RunnerResult` shape, and the
  optional `RunReviewDeps` shape.
- `composeSystemPrompt`, `wrapUntrusted`, `loadSkills`,
  `renderSkillsBlock` — composable building blocks for advanced
  wirings (CLI, server, custom adapters).
- `dedupComments`, `decideCoordination`, `renderDeferralSummary`,
  `buildReviewState`, `scanWorkspaceWithGitleaks`,
  `quickScanContent`, `applyRedactions`, `shouldAbortReview`,
  `classifyForInjection`, `redactInjectionBlocks`,
  `INJECTION_VERDICTS`, `resolveInjectionDetectorPolicy` — all
  stable.
- `INJECTION_DETECTOR_SYSTEM_PROMPT` — the **identifier** is
  stable (it stays exported from `@review-agent/runner`), but the
  **string value** is treated as tunable: rewording the prompt is
  a patch-level change (see "Internal-only surfaces" below). Do
  not compare it against a hardcoded value.
- The middleware factory signatures (`createInjectionGuard`,
  `createCostGuard`) and the `Middleware` / `MiddlewareCtx` types.

### `@review-agent/config`

- `ConfigSchema` (and the inferred `Config` / `ConfigInput` types).
- The `version: 1` contract for `.review-agent.yml`. Breaking
  changes to the YAML schema bump `version` (e.g. `version: 2`) and
  ship with a documented migration in the `## From 1.y → 2.0` section.
- `loadConfigFromYaml`, `defaultConfig`, `mergeWithEnv`,
  `loadConfigWithOrgFallback`, `createOrgConfigCache`,
  `mergeOrgIntoRepo`, `generateJsonSchema`,
  `KNOWN_REVIEW_BOT_LOGINS`, `isKnownReviewBotLogin`,
  `SUPPORTED_LANGUAGES`, `isSupportedLanguage`.

### `@review-agent/platform-github`

- `createGithubVCS({ token | appAuth })` — the `VCS` it returns is
  the `core` interface (which is itself stable).
- `createGithubOrgConfigFetch({ octokit })` for org-config
  resolution.

### `action.yml` (GitHub Action)

The Action's inputs and outputs are part of the public API.

| Surface | Stability |
|---|---|
| Input names: `github-token`, `anthropic-api-key`, `language`, `config-path`, `cost-cap-usd` | Stable. Renaming → major. |
| Default values | Renaming a default that flips behaviour → major. Tweaking a default within compatible behaviour (e.g. nudging `cost-cap-usd` from 1.0 to 0.75) → minor with release-note callout. |
| Outputs: `posted-comments`, `cost-usd` | Stable. Renaming → major. |
| `runs.using: node20` | Bumping the Node major (e.g. node22) → minor; runtime contract preserved by Actions backwards compatibility. |

### CLI flags

The `review-agent` CLI's documented subcommand list and flag set is
part of the public API.

| Surface | Stability |
|---|---|
| Subcommands: `review`, `config validate`, `config schema`, `eval`, `recover sync-state`, plus v1.0 additions (`setup workspace`) | Stable. Removing a subcommand → major. |
| Flag names: `--repo`, `--pr`, `--config`, `--lang`, `--profile`, `--cost-cap-usd`, `--post`, `--suite`, `--installation`, `--api`, `--admin-key` (where applicable) | Stable. Renaming → major. |
| Default flag values | Same rule as Action defaults. |
| Exit codes (0 success, 1 failure, 2 reserved for misuse via Commander) | Stable. |

---

## Internal-only surfaces (NOT covered by SemVer)

The following may change between any two releases — including patch
releases. Do not import these in third-party code:

- Anything under `packages/*/src/internal/`.
- Anything under `packages/runner/src/middleware/` directly (use the
  re-exported factories instead).
- Prompt strings: `composeSystemPrompt`'s output text format and
  the body of the `INJECTION_DETECTOR_SYSTEM_PROMPT` constant + the
  redaction placeholder string. We expose the identifiers as
  stable but treat the *content* as tunable — rewording the prompt
  is a patch-level change. Breaking the function *signature* (for
  `composeSystemPrompt`) or removing the export entirely (for the
  constant) is major.
- Telemetry attribute names emitted via OTel (`packages/server`,
  `packages/runner`). Operators wiring dashboards should treat the
  schema as evolving and pin their dashboard queries by attribute
  *intent*, not name.
- The internal Drizzle column names and indexes in
  `packages/db/src/schema/`. Migrations are the stable contract;
  TypeScript identifiers may be renamed.
- Test fixtures, eval baseline format internals, golden-fixture
  manifest schema (the *eval pipeline contract* is stable, but
  individual fixture file shapes are not).
- The HTTP shape of the webhook receiver beyond what GitHub
  documents (we just relay GitHub's payload semantics).

---

## Migration patterns

When a major bump is required, the corresponding `## From X.y → Z.0`
section uses a fixed shape so operators can scan quickly:

1. **Summary** — one paragraph naming the breaking change and the
   reason.
2. **Affected surfaces** — bullet list of files / exports / config
   keys that changed.
3. **Migration** — concrete code or YAML diff showing before / after.
4. **Detection** — how to know if your installation is affected
   (e.g. "`pnpm typecheck` will fail with this error", or "schema
   validation will reject `.review-agent.yml`").
5. **Removal timeline** — if a deprecated alias ships first, when
   it's removed.

Migrations should be runnable by an operator following the doc
top-to-bottom in 30 minutes for the median upgrade. Anything more
ambitious gets a dedicated `docs/migrations/<topic>.md`.

---

## From 1.1 → 1.2

v1.2 is a **minor** bump — every change below is backwards-compatible.
Existing `.review-agent.yml` files keep working byte-for-byte; existing
`runReview` / `wrapUntrusted` / `postReview` call sites continue to
compile without arg changes (every new `RunReviewDeps` field is
optional). The migration adds one new table + one new column, both
forward-compatible (v1.1 code keeps reading the DB without seeing them).

### 1. DB migration (mandatory before deploying v1.2 code)

Run the migration **before** rolling out the v1.2 code. The migration
is forward-compatible — v1.1 code keeps working against the migrated
schema (the v1.1 code does not reference `review_eval_event` or
`cost_ledger.latency_ms`).

```bash
pnpm --filter @review-agent/db db:migrate
```

(or equivalent: `psql -f packages/db/migrations/0003_review_eval_event.sql`
under the migrations-superuser role).

| Object | Change |
|---|---|
| `review_eval_event` (new table) | Per-review metrics — token / cost / latency / `droppedByDedup` / `droppedByFeedback` / `feedbackCount`. RLS-isolated by `installation_id` (spec §7.5). |
| `cost_ledger.latency_ms` (new nullable column) | Defaults to `NULL` for existing rows; v1.2 writes the per-row latency from the EvalMiddleware. |

Rollback: do **not** run a down-migration. v1.1 code reads from
neither object, so leaving them in place after a rollback is safe. If
you genuinely need to remove them, drop the table / column manually
**after** all v1.2 writers are off.

### 2. New optional `runReview` deps (v1.2 epic #83)

All four are off by default — omit them to preserve v1.1 behaviour.

| Dep | Purpose | Wire when |
|---|---|---|
| `evalRecorder` + `evalContext` | Records one `ReviewEvalEvent` per `runReview` into `review_eval_event` (Phase 2 / #91). Fail-open. | You want per-review metrics, judge scores (#101), or feedback analytics. |
| `historyReader` | Loads `review_history` rows (Phase 4 / #93) for `<learned_facts>` injection + dedup. | You want the feedback loop closed (signal-driven `<learned_facts>`). |
| `onEvalRecordError` / `onHistoryReaderError` | Fail-open observability — bridge to OTel counters (#106). | You wired OTel and want fail-open errors visible. |

See `docs/architecture/feedback-loop.md` for the wiring diagram. A worked
example handler will live at `docs/operations/worker-example.md` (#98).

### 3. New optional config keys (`.review-agent.yml` v1)

Added on the same `version: 1` schema — no `version: 2` bump.

| Key | Default | Section |
|---|---|---|
| `repo.submodules` | `false` | Set `true` to recurse submodules during sparse-clone workspace provisioning (#89). |
| `repo.lfs` | `false` | Set `true` to fetch LFS pointers; default keeps `GIT_LFS_SKIP_SMUDGE=1` so reviews never pull binary blobs (#89). |
| `reviews.path_filters` | `[]` (no skip) | Globs whose matching paths skip review entirely. Zero-cost cap — the agent emits a graceful "skipped" summary instead of calling the LLM (#88). |
| `reviews.max_files` | unset (no cap) | Integer cap; PRs touching > N files skip review with a graceful summary (#88). |
| `reviews.max_diff_lines` | unset (no cap) | Integer cap; PRs whose total diff exceeds N lines skip review with a graceful summary (#88). |
| `privacy.allowed_url_prefixes` | own-repo auto-allow | URL allowlist for LLM-emitted links in `ReviewOutputSchema`. Retry-once-then-graceful-abort on schema violation (#85). |
| `privacy.deny_paths` | `[]` | Glob list applied to `read_file` / `glob` / `grep` tool dispatch. **Extends** built-in `.env*` / `.ssh/**` / `.aws/credentials` denylist; never relaxes (#86). |
| `privacy.redact_patterns` | `[]` | Additional gitleaks rules (`custom-N`) applied alongside built-ins on both diff pre-scan and post-LLM redaction (#87). |

`.review-agent.yml` schema dump: regenerate via
`pnpm --filter @review-agent/config generate-schema` (or pull the latest
`schema/v1.json`). All v1.1 → v1.2 keys are optional; old files validate
unchanged.

**v1.1-was-silently-ignored note**: these keys *parsed* in v1.1 (they
were in the schema) but were not enforced anywhere. v1.2 enforces them.
Operators who left dead keys in their YAML thinking they were no-ops
will now see behaviour change — review your existing YAML before
deploying.

### 4. New CLI subcommands

| Subcommand | Purpose |
|---|---|
| `review-agent feedback backfill --installation-id N --repo owner/repo [--since YYYY-MM-DD] [--state-file path] [--dry-run]` | Populates `review_history` from historical GitHub reactions for tenants deployed before v1.2 (#99). Resumable via `--state-file`. CodeCommit tenants are out of scope (see #95 / #96). |

### 5. New public exports

The following identifiers are now part of the SemVer-stable public API
surface:

- `@review-agent/core`: `appendFingerprintMarker`,
  `extractFingerprintFromComment`, `FeedbackEvent`, `FeedbackKind`,
  `FEEDBACK_KINDS`, `feedbackKindToFactType`, `ReviewEvalEvent`,
  `ReviewEvalEventRecorder`.
- `@review-agent/runner`: `createFeedbackWriter`, `FeedbackWriter`,
  `FeedbackWriterOptions`, `ReviewHistoryWriter`,
  `extractFingerprintMarker`, `resolveFingerprint`,
  `FingerprintResolution`, `FingerprintResolutionInput`.
- `@review-agent/server`: `startReviewHistoryCleanup`,
  `ReviewHistoryCleanupDeps`, `handleCodecommitWebhook`,
  `CodecommitWebhookDeps`, `CodecommitWebhookResult`,
  `recordFeedbackCommandOutcome`, `FeedbackCommandOutcome`,
  `parseFeedbackCommand`, `FeedbackCommand`, `FeedbackCommandKind`,
  `FEEDBACK_COMMAND_PREFIX`, `checkGithubFeedbackAuthz`,
  `checkCodeCommitFeedbackAuthz`, `FeedbackAuthzResult`,
  `bridgeEvalRecordErrorsToMetrics`, `bridgeFeedbackRateLimitToMetrics`,
  `bridgePrunedRowsToMetrics`, `bridgeHistoryReaderErrorsToMetrics`.

### 6. CodeCommit feature parity status

| Phase | Status on CodeCommit |
|---|---|
| Phase 1 (eval baseline) | ✅ same as GitHub — `severity_consistency_score` etc. is repo-agnostic. |
| Phase 2 (per-review metrics) | ✅ — `evalRecorder` runs in the worker regardless of platform. |
| Phase 3 (feedback writer) | **Partial** — CodeCommit has no reaction API. v1.2 wave A adds `/feedback` comment command (#95 partial: `fp_prefix` path only; #96 enables marker path with no further code change). |
| Phase 4 (`<learned_facts>` reader) | ✅ — reader is provider-agnostic. Fact density on CodeCommit tenants will lag GitHub until #95 / #96 land in full. |

### 7. Behaviour changes operators may notice

- **Bot inline comments now end with `<!-- fingerprint:<16-hex> -->`** (#96).
  The marker is a hidden HTML comment so end-user UX is unchanged. It
  unblocks the `/feedback` (#95) marker-based resolver path.
- **`/feedback accept|reject|dismiss` comments are recognised on
  both GitHub and CodeCommit** (#95). Guarded by repo write
  permission (GitHub) or `REVIEW_AGENT_FEEDBACK_ALLOWLIST` env CSV
  (CodeCommit, fail-closed when unset). See
  `docs/security/feedback-command-authz.md`.
- **`review_history` rows accumulate** if you wire the writer.
  `startReviewHistoryCleanup` prunes them at the 180-day TTL — wire
  it alongside `startWorker`. The default tick interval is 1h.
- **Cost-guard accounting includes tool calls** (already true in v1.1
  but now visible via `review_eval_event.totalTokens` /
  `cost_ledger.latency_ms` per-review).

### 8. Baseline / parity / judge enforcement

The new evaluation infrastructure is **informational by default**:

- `severity_consistency_score` in `baseline.json` is `null` until an
  operator runs `pnpm --filter @review-agent/eval baseline:measure --apply`
  with a real `ANTHROPIC_API_KEY` (#97).
- `parity.json` per-provider scores are `null` until #102 populates
  them.
- `llm_judge_score` (#101) runs `continue-on-error: true` and is
  always informational — promotion to an enforcing gate is a separate
  follow-up.

Skip the measurement steps to keep v1.2 fully passive.

### 9. Detection

`pnpm --filter @review-agent/config generate-schema` will refuse to
emit if any new v1.2 key has a typo. Beyond that, all additions are
silent opt-ins — operators who don't wire any of `evalRecorder`,
`historyReader`, `createFeedbackWriter`, `startReviewHistoryCleanup`
keep v1.1 runtime behaviour byte-for-byte.

---

## From 1.0 → 1.1

v1.1 is a **minor** bump — every change below is backwards-compatible.
Existing `.review-agent.yml` files keep working byte-for-byte; existing
`runReview` / `wrapUntrusted` / `postReview` call sites continue to
compile without arg changes (the new parameters are optional). Operators
who want the new behaviour opt in via the config keys / action inputs /
CLI subcommands listed below.

Includes v1.0.1 (#59, #60) — both architectural gaps from the v1.0
multi-agent audit landed in the same wave as v1.1 features; there is no
separate v1.0.1 release-line.

### 1. New optional config keys (`.review-agent.yml` v1)

| Key | Default | Section |
|---|---|---|
| `reviews.min_confidence` | `'low'` (post everything) | `'high'` / `'medium'` / `'low'` — drops comments strictly below the floor. Comments without a `confidence` field are treated as `'high'`. See [`docs/configuration/review-output.md`](docs/configuration/review-output.md). |
| `reviews.request_changes_on` | `'critical'` | `'critical'` / `'major'` / `'never'` — chooses the severity floor at which the GitHub review event flips from `COMMENT` to `REQUEST_CHANGES`. Wiring instructions for branch protection are in [`SECURITY.md`](SECURITY.md). |
| `reviews.path_instructions[i].auto_fetch` | unset (no auto-fetch) | `{ tests?: bool; types?: bool; siblings?: bool }` — pre-fetches related files when a changed path matches the instruction's `path` glob. Defaults if the key is present: `tests=true, types=true, siblings=false`. Budgeted at 5 files / 50 KB each / 250 KB total. See [`docs/configuration/path-instructions.md`](docs/configuration/path-instructions.md). |
| `server.workspace_strategy` | `'none'` (preserves v0.2 / v1.0 behaviour) | `'none'` / `'contents-api'` / `'sparse-clone'` — provisions a per-job ephemeral workspace in Server mode so the LLM's file tools have files to read. See [`docs/deployment/aws.md`](docs/deployment/aws.md) §8.1. |

`reviews.path_instructions[i].path` is now validated as a glob at config
load — typos like `src/utils/\*.ts` are rejected with a clear error
instead of silently never matching.

### 2. New GitHub Action input

| Input | Default | Description |
|---|---|---|
| `state-write-retries` | `'3'` | Integer in `[0, 5]`. Retries on 429 + 5xx of `vcs.postReview` and `vcs.upsertStateComment` with exp-backoff 1s / 3s / 9s; non-429 4xx is not retried. `0` = fail-fast (single attempt). On exhaustion of the state-comment write the action fails with `State comment write failed after N retries; next review will be a full re-review.` so the next push doesn't silently re-review the whole PR. |

### 3. New CLI subcommands

| Subcommand | Purpose |
|---|---|
| `review-agent audit export --installation N --since YYYY-MM-DD [--until ...] --output file.jsonl.gz` | Gzipped JSONL export of `audit_log` + `cost_ledger` for the installation. Pre-export verifies the HMAC chain; refuses to write a tainted archive. |
| `review-agent audit prune --before YYYY-MM-DD [--confirm]` | Dry-run by default; `--confirm` actually deletes rows older than the boundary. Keeps the most-recent row before the boundary as the new chain anchor; re-verifies the segment post-delete and exits non-zero on chain break. |

**Required DB role**: the audit CLI does not wrap its queries in
`withTenant(...)`. Run it under an RLS-bypass role (the migrations
superuser or a dedicated `review_agent_admin`); an `appRole`
connection silently returns zero rows. Documented in
[`docs/operations/retention.md`](docs/operations/retention.md).

### 4. Schema additions (backwards-compatible)

| Schema | Added | Notes |
|---|---|---|
| `InlineCommentSchema` (`@review-agent/core`) | `category?` (enum), `confidence?` (`'high'`/`'medium'`/`'low'`), `ruleId?` (kebab-case, ≤ 64 chars) | All optional; old reviews validate unchanged. `.refine` enforces the cross-field invariant `category='style'` → `severity` ≤ `'minor'`. |
| `ReviewStateSchema` (`@review-agent/core`, new export) | Replaces the shallow `isReviewState` type guard. SHA / fingerprint regexes, nonnegative tokens / cost, datetime validation. | Corrupted state comments now log + drop instead of silently feeding stale baseSha into dedup. |
| `PR.commitMessages` (`@review-agent/core`) | `ReadonlyArray<{ sha; message }>` | GitHub adapter populates via `pulls.listCommits` (last page only — single API call on typical PRs, max 2). CodeCommit returns `[]`. Bounded at 20 commits × 5000 chars per message. |
| `ReviewPayload.event?` (`@review-agent/core`) | `'COMMENT' \| 'REQUEST_CHANGES' \| 'APPROVE'` | Optional; defaults to `'COMMENT'` for back-compat. `postReview` honours it on GitHub; CodeCommit drops it. |

### 5. New public exports

The following identifiers are now part of the SemVer-stable public API
surface:

- `@review-agent/core`: `computeReviewEvent`, `REVIEW_EVENTS`,
  `ReviewEvent`, `REQUEST_CHANGES_THRESHOLDS`, `RequestChangesThreshold`,
  `CATEGORIES`, `Category`, `CONFIDENCES`, `Confidence`,
  `ReviewStateSchema`,
  `REVIEW_STATE_SCHEMA_VERSION`, `WORKSPACE_STRATEGIES`,
  `WorkspaceStrategy`, `verifyAuditChainSegment`,
  `globToRegExp`, `isValidGlob`.
- `@review-agent/runner`: `MAX_TOOL_CALLS`, `createAiSdkToolset`,
  `collectAutoFetchContext`. The `renderRelatedFiles` helper that
  briefly existed during the wave was removed before release —
  callers should pass auto-fetched files to `wrapUntrusted(meta,
  relatedFiles)` instead, which places `<related_files>` inside the
  trust envelope.
- `@review-agent/server`: `provisionWorkspace`,
  `ProvisionWorkspaceDeps`, `ProvisionWorkspaceInput`,
  `WorkspaceHandle`, `WorkspaceStrategy`.

### 6. Behaviour changes operators may notice

- **The 2nd+ review of a PR sends only the incremental diff** to the
  LLM (issue #60). The action now logs `'incremental review'` /
  `'rebase detected'` lines so operators can see which path each
  review took.
- **The LLM may call `read_file` / `glob` / `grep` during review**
  (issue #59), bounded by `MAX_TOOL_CALLS = 20` and the existing
  deny-list. Cost-guard accounting now includes tool calls; expect
  modestly higher `result.tokensUsed` on PRs that benefit from
  multi-file context.
- **The `<untrusted>` wrapper now includes `<base_branch>`,
  `<labels>`, and `<commits>`** alongside title/body/author. The
  system prompt instructs the model that labels are operator hints
  (never directives) and commit messages must never be executed as
  instructions.
- **Server mode**: with `workspace_strategy: 'none'` (default), Server
  reviews continue to see only the diff text. Opt into
  `'contents-api'` (pure Octokit, Lambda-friendly) or `'sparse-clone'`
  (requires `git` binary in the image) to materialise a per-job
  ephemeral workspace.

### 7. Detection

Most additions are silent opt-ins. The one detection point: if your
operator has an `.review-agent.yml` linter pinned to v1.0's JSON
Schema, it will reject new keys until you regenerate the schema via
`pnpm --filter @review-agent/config generate-schema` (or simply pull
the latest `schema/v1.json`).

---

## From 0.x → 1.0

_v1.0 is the first SemVer-stable release. There is no source
release-line below 0.3 that is upgrade-compatible with v1.0._

Operators currently on `0.3.x` should:

1. **Pin the v1.0 release tag** in CI (`almondoo/review-agent@v1`) and
   re-run a self-review on a representative PR.
2. **Validate `.review-agent.yml`** with
   `review-agent config validate` — any schema breakages from
   v0.3 → v1.0 surface here. (None are planned at this time;
   this section will be updated if any land before tag.)
3. **Re-read [`docs/configuration/coordination.md`](docs/configuration/coordination.md)
   and [`docs/configuration/bot-identity.md`](docs/configuration/bot-identity.md)**
   for the v1.0 stances on multi-bot coexistence and audit-trail
   identity, both of which were deferred design questions in v0.3.
4. **Decide the GHES posture**:
   [`docs/deployment/ghes.md`](docs/deployment/ghes.md) declares
   `best-effort, no commitment` — confirm this is acceptable for
   your installation, or fork.
5. **Refresh provider parity numbers**: see
   [`docs/providers/parity-matrix.md`](docs/providers/parity-matrix.md)
   for the v1.0 cross-provider eval results, regenerated via
   `pnpm --filter @review-agent/eval matrix:run`.

There is no automated migration. The v1.0 surface is intended to
match the v0.3 surface byte-for-byte; the bump's purpose is the
SemVer guarantee, not new code.

---

## Release process

1. Add a changeset for every PR that touches a public-API package
   (`pnpm changeset`). The changeset declares the bump type:
   `patch`, `minor`, or `major`. **Major bumps must include a draft
   `## From X.y → Z.0` migration section in the changeset body.**
   See [`.github/CONTRIBUTING.md`](.github/CONTRIBUTING.md) §
   "Changesets" for the policy.
2. `pnpm changeset:version` consumes pending changesets, updates
   `package.json` versions, and writes per-package `CHANGELOG.md`.
3. The release workflow (`.github/workflows/release.yml`) tags the
   monorepo as `v<root-version>` and publishes the public packages
   to npm.
4. The corresponding `## From X.y → Z.0` section is promoted from
   the changeset draft into this file before the tag is pushed.

The internal-only packages (`@review-agent/server`, `@review-agent/db`,
test fixtures) bump independently and don't appear in this file's
migration sections.

---

## Cross-references

- [`docs/specs/review-agent-spec.md`](docs/specs/review-agent-spec.md) — implementation specification (source of truth for behaviour).
- [`docs/specs/prd.md`](docs/specs/prd.md) §12.1 v1.0 acceptance — "API stability declaration (SemVer に移行、UPGRADING.md 整備)" closed by this document.
- [`README.md`](README.md) — quickstart; links here from the Status section.
- [`.github/CONTRIBUTING.md`](.github/CONTRIBUTING.md) — Changesets policy on bump-type tagging.
