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
  `buildReviewState`, `createCostKillSwitch`, `assertDailyCapNotExceeded`,
  `preflightDailyCap`, `scanWorkspaceWithGitleaks`,
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
