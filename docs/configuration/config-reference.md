# `.review-agent.yml` Configuration Reference

Every key is optional. Omitted keys take the documented default.
The YAML file lives at the repository root (`.review-agent.yml`).
Org-central config lives in `<org>/.github/review-agent.yml`.

**Schema**: [`schema/v1.json`](../../schema/v1.json) — the JSON Schema is the
source of truth for types, defaults, and enums. Add `# yaml-language-server:
$schema=https://review-agent.dev/schema/v1.json` to the top of your
`.review-agent.yml` for IDE autocomplete in VS Code (requires the
[YAML extension](https://marketplace.visualstudio.com/items?itemName=redhat.vscode-yaml)):

```yaml
# yaml-language-server: $schema=https://review-agent.dev/schema/v1.json
language: en-US
```

Precedence (highest → lowest, per §10.2):

1. PR comment commands (`@review-agent --lang ja-JP`, etc.)
2. Repository `.review-agent.yml`
3. Organization central config (`<org>/.github/review-agent.yml`)
4. Environment variables (`REVIEW_AGENT_*`)
5. Built-in defaults (this document)

> **Note on env vs config precedence**: env variables currently override YAML
> config. Correcting this to `config > env` (per §10.2) is tracked in issue
> #156. The table below documents the intended final order.

---

## Top-level keys

| Key | Type | Default | Scope | Description |
|---|---|---|---|---|
| `extends` | `'org'` \| `null` | `null` | repo | Opt in to inheriting the org central config under this file. When set to `'org'`, org config is merged below repo config (org provides defaults, repo overrides). |
| `language` | ISO 639-1+region string | `'en-US'` | repo, org, env | Output (comment) language. Supported codes are in `packages/config/src/languages.ts`. Internal prompts are always English (§2.2). Env: `REVIEW_AGENT_LANGUAGE`. |
| `profile` | `'chill'` \| `'assertive'` | `'chill'` | repo, org | Review tone profile. `chill` = constructive suggestions; `assertive` = firm blocking findings. |

---

## `provider`

Controls which LLM backend is used for this repository.

| Key | Type | Default | Scope | Description |
|---|---|---|---|---|
| `provider.type` | enum | _(no default — env-resolved)_ | repo, org, env | Provider: `anthropic`, `openai`, `azure-openai`, `google`, `vertex`, `bedrock`, `openai-compatible`. Env: `REVIEW_AGENT_PROVIDER`. |
| `provider.model` | string | _(provider-specific)_ | repo, org, env | Model ID for the selected provider. Env: `REVIEW_AGENT_MODEL`. |
| `provider.fallback_models` | string[] | `[]` | repo, org | Tried in order on rate-limit or availability errors. |
| `provider.base_url` | URL string | — | repo, org | Required for `openai-compatible` (e.g. Ollama, OpenRouter). |
| `provider.region` | string | — | repo, org | `bedrock` or `vertex` region. |
| `provider.azure_deployment` | string | — | repo, org | Azure OpenAI deployment name. |
| `provider.vertex_project_id` | string | — | repo, org | Vertex AI project ID. |
| `provider.anthropic_cache_control` | boolean | `true` | repo, org | Enable Anthropic prompt caching for cost reduction. |

---

## `reviews`

Controls what gets reviewed and how.

| Key | Type | Default | Scope | Description |
|---|---|---|---|---|
| `reviews.auto_review.enabled` | boolean | `true` | repo, org | Enable automatic review on PR open/update. |
| `reviews.auto_review.drafts` | boolean | `false` | repo, org | Review draft PRs. |
| `reviews.auto_review.base_branches` | string[] | `['main', 'master', 'develop']` | repo, org | Only trigger on PRs targeting these branches. |
| `reviews.auto_review.paths` | string[] | `[]` (all paths) | repo, org | Only trigger when the diff intersects these glob patterns. Empty = always trigger. |
| `reviews.auto_review.trigger_labels` | string[] | `[]` | repo, org | Only trigger auto-review when the PR has at least one of these labels. Empty = always trigger (regardless of labels). |
| `reviews.auto_review.skip_labels` | string[] | `[]` | repo, org | Skip auto-review when the PR has any of these labels (e.g. `do-not-review`, `wip`). Evaluated after `trigger_labels`. |
| `reviews.path_filters` | string[] | `[]` | repo, org | Glob patterns to exclude from review. Prefix with `!` (e.g. `!dist/**`). Org + repo lists are concatenated. |
| `reviews.path_instructions` | array | `[]` | repo, org | Per-path agent instructions. See [path-instructions.md](./path-instructions.md). |
| `reviews.max_files` | positive integer | `50` | repo, org | Hard cap on files reviewed per PR. PRs exceeding this are skipped with a summary comment. |
| `reviews.max_diff_lines` | positive integer | `3000` | repo, org | Hard cap on diff lines reviewed per PR. |
| `reviews.ignore_authors` | string[] | `['dependabot[bot]', 'renovate[bot]', 'github-actions[bot]']` | repo, org | Skip review for PRs authored by these logins. Org + repo lists are concatenated. |
| `reviews.min_confidence` | `'high'` \| `'medium'` \| `'low'` | `'low'` | repo, org | Suppress comments whose model confidence is strictly below this value. `low` = post everything. Comments with no confidence field are treated as `'high'`. |
| `reviews.request_changes_on` | `'critical'` \| `'major'` \| `'never'` | `'critical'` | repo, org | Severity threshold at which the reviewer posts `REQUEST_CHANGES` instead of `COMMENT`. `never` = always post `COMMENT`. |
| `reviews.max_steps` | integer (1–50) | `20` | repo, org | Maximum number of agent-loop tool-call steps per review run. Raise to allow deeper exploration of large PRs; lower to cap latency. |
| `reviews.max_conversation_turns` | integer (1–50) | `5` | repo, org | Maximum back-and-forth turns in an inline comment thread before the agent stops replying. |

---

## `cost`

| Key | Type | Default | Scope | Description |
|---|---|---|---|---|
| `cost.max_usd_per_pr` | positive number | `1.0` | repo, org, env | Per-PR cost cap in USD. Env: `REVIEW_AGENT_MAX_USD_PER_PR`. |
| `cost.hard_stop` | boolean | `true` | repo, org | When `true`, abort the review if `max_usd_per_pr` is exceeded. When `false`, the runner falls back to a cheaper model instead. |
| `cost.daily_cap_usd` | positive number | `50.0` | repo, org | Per-installation daily cost cap. Shared across all repos in the installation. |

---

## `privacy`

| Key | Type | Default | Scope | Description |
|---|---|---|---|---|
| `privacy.redact_patterns` | string[] | `[]` | repo, org | Additional regex patterns to redact from diffs and LLM output. Extends the built-in gitleaks ruleset — never replaces it. Each entry must be a valid JS regex. Org + repo lists are concatenated and deduped. |
| `privacy.deny_paths` | string[] | `[]` | repo, org | Additional glob patterns to block from `read_file`/`glob`/`grep` tool calls. Extends the built-in deny list (§7.4). Org + repo lists are concatenated and deduped. |
| `privacy.allowed_url_prefixes` | URL prefix string[] | `[]` | repo, org | Additional URL prefixes the LLM is allowed to link to in comments. The PR's own repo URL is always allowed. |

---

## `repo`

| Key | Type | Default | Scope | Description |
|---|---|---|---|---|
| `repo.submodules` | boolean | `false` | repo, org | Fetch and review submodule content. |
| `repo.lfs` | boolean | `false` | repo, org | Fetch LFS pointers for review. |

---

## `skills`

| Key | Type | Default | Scope | Description |
|---|---|---|---|---|
| `skills` | string[] | `[]` | repo, org | Skill file paths relative to the repo root (e.g. `.review-agent/skills/security.md`). Org + repo lists are concatenated. npm-distributed packages are planned (#154). See [Skills docs](../getting-started/skills.md). |

---

## `incremental`

| Key | Type | Default | Scope | Description |
|---|---|---|---|---|
| `incremental.enabled` | boolean | `true` | repo, org | When `true`, only the commits since the last review are reviewed on subsequent pushes to a PR. Set `false` to always do a full-PR review. |

---

## `coordination`

Controls coexistence with other PR-review bots.

| Key | Type | Default | Scope | Description |
|---|---|---|---|---|
| `coordination.other_bots` | `'ignore'` \| `'defer_if_present'` | `'ignore'` | repo, org | `ignore` = review independently. `defer_if_present` = post a skip summary if any bot in the allowlist has already commented on this PR. |
| `coordination.other_bots_logins` | string[] | `[]` | repo, org | Additional bot logins to include in the coexistence allowlist. Adds to the built-in list; never replaces it. |

---

## `server`

Server / CLI mode only. Ignored by the GitHub Action (which uses the actions/checkout workspace).

| Key | Type | Default | Scope | Description |
|---|---|---|---|---|
| `server.workspace_strategy` | `'none'` \| `'contents-api'` \| `'sparse-clone'` | `'none'` | repo, org | How the server provisions a workspace for `read_file`/`glob`/`grep`. `none` = tools disabled. `contents-api` = GitHub Contents API (cheap). `sparse-clone` = sparse git clone (richer, needs `git` in Lambda). |

---

## `codecommit`

CodeCommit-specific settings. Ignored by all other VCS adapters.

| Key | Type | Default | Scope | Description |
|---|---|---|---|---|
| `codecommit.approvalState` | `'managed'` \| `'off'` | `'off'` | repo, org | `managed` = translate review event to `UpdatePullRequestApprovalState`. `off` = leave approval rules to the operator. |

---

## `suggestions`

Controls how `suggestion` fields from LLM findings are rendered in inline
review comments. See [suggestions.md](./suggestions.md) for full details.

| Key | Type | Default | Scope | Description |
|---|---|---|---|---|
| `suggestions.enabled` | boolean | `true` | repo, org | When `false`, all `suggestion` fields are stripped before posting; only the comment body is published. |
| `suggestions.categories` | `Category[]` | all categories | repo, org | Only render suggestion blocks for findings in these categories. Findings in other categories lose the suggestion block (body preserved). Findings with no `category` field always keep their suggestion. |

---

## `large_pr`

Controls how the runner handles PRs that exceed the `reviews.max_files` or
`reviews.max_diff_lines` caps. See [large-pr.md](./large-pr.md) for full details.

| Key | Type | Default | Scope | Description |
|---|---|---|---|---|
| `large_pr.enabled` | boolean | `true` | repo, org | When `true` (default), split the diff into chunks and review each chunk in sequence. When `false`, restore the pre-v1.2 hard-skip behaviour. |
| `large_pr.max_chunks` | positive integer | `5` | repo, org | Maximum number of LLM passes per PR. Files in chunks beyond this limit are skipped and reported as `max_chunks_exceeded`. |
| `large_pr.prioritization` | `('path_instructions' \| 'diff_size' \| 'alphabetical')[]` | `['path_instructions', 'diff_size']` | repo, org | Ordered criteria for ranking files before chunk assignment. Alphabetical is always the final tiebreak. |

---

## `external_tools`

Ingest SARIF 2.1.0 output from CI static-analysis tools and merge findings with
the AI review. See [external-tools.md](./external-tools.md) for full details.

| Key | Type | Default | Scope | Description |
|---|---|---|---|---|
| `external_tools.tools[].name` | string | — | repo | Display name for the tool (required). |
| `external_tools.tools[].sarif_path` | string | — | repo | Filesystem path to the tool's SARIF output file (required). |
| `external_tools.tools[].merge_policy` | `tool_wins` \| `ai_wins` \| `annotate` | `tool_wins` | How to resolve fingerprint conflicts between external and AI findings. |

---

## `ruleset`

Controls which finding categories are active and the minimum severity reported
per category. All seven categories are enabled by default with minimum severity
`info` (i.e., all severities posted).

| Key | Type | Default | Scope | Description |
|---|---|---|---|---|
| `ruleset.bug.enabled` | boolean | `true` | repo, org | Enable bug findings. |
| `ruleset.bug.min_severity` | `'critical'` \| `'major'` \| `'minor'` \| `'info'` | `'info'` | repo, org | Minimum severity to post for bug findings. Lower severity findings are suppressed. |
| `ruleset.security.enabled` | boolean | `true` | repo, org | Enable security findings. |
| `ruleset.security.min_severity` | severity enum | `'info'` | repo, org | Minimum severity for security findings. |
| `ruleset.performance.enabled` | boolean | `true` | repo, org | Enable performance findings. |
| `ruleset.performance.min_severity` | severity enum | `'info'` | repo, org | Minimum severity for performance findings. |
| `ruleset.maintainability.enabled` | boolean | `true` | repo, org | Enable maintainability findings. |
| `ruleset.maintainability.min_severity` | severity enum | `'info'` | repo, org | Minimum severity for maintainability findings. |
| `ruleset.style.enabled` | boolean | `true` | repo, org | Enable style findings. |
| `ruleset.style.min_severity` | severity enum | `'info'` | repo, org | Minimum severity for style findings. |
| `ruleset.docs.enabled` | boolean | `true` | repo, org | Enable documentation findings. |
| `ruleset.docs.min_severity` | severity enum | `'info'` | repo, org | Minimum severity for documentation findings. |
| `ruleset.test.enabled` | boolean | `true` | repo, org | Enable test-coverage / test-quality findings. |
| `ruleset.test.min_severity` | severity enum | `'info'` | repo, org | Minimum severity for test findings. |

Valid severity enum values: `'critical'` `'major'` `'minor'` `'info'`.

**Example** — disable style and docs, only report major+ performance findings:

```yaml
ruleset:
  style:
    enabled: false
  docs:
    enabled: false
  performance:
    min_severity: major
```

See also: [schema-validation.md](./schema-validation.md) for per-path ruleset
overrides via `path_instructions`.

---

## `feedback`

Controls how the false-positive suppression system treats repeated findings.

| Key | Type | Default | Scope | Description |
|---|---|---|---|---|
| `feedback.suppress_after` | positive integer | `3` | repo, org | Number of thumbs-down reactions on a finding fingerprint before that fingerprint is suppressed in future reviews. Minimum: 1. |

When a reviewer reacts with 👎 to a review comment, the runner increments a
suppression counter for that finding's fingerprint. Once the counter reaches
`suppress_after`, the fingerprint is added to the mute list and the finding is
silently omitted from future reviews.

**Example** — require 5 negative reactions before suppressing:

```yaml
feedback:
  suppress_after: 5
```

See also: [operations/feedback-suppression.md](../operations/feedback-suppression.md)
for the backfill and reset procedures.

---

## Effective-config resolution log

Since issue #146, every run emits a `ConfigResolutionLog` that records which
source contributed to the effective config. Callers wire the `onConfigResolution`
hook on `RunReviewDeps` to observe it:

```typescript
import type { ConfigResolutionLog } from '@review-agent/config';

await runReview(job, provider, {
  onConfigResolution: (log: ConfigResolutionLog) => {
    console.log('Config resolution:', JSON.stringify(log, null, 2));
  },
});
```

Example log:

```json
{
  "primarySource": "repo-yaml",
  "orgYamlLoaded": false,
  "envApplied": false,
  "sections": {
    "language": "repo-yaml",
    "profile": "default",
    "reviews": "repo-yaml",
    "cost": "default",
    "privacy": "default",
    "repo": "default",
    "skills": "default",
    "incremental": "default",
    "coordination": "default",
    "server": "default",
    "codecommit": "default"
  }
}
```

Pass `job.resolutionLog` (from `resolveEffectiveConfig`) to make the hook fire.
See `packages/config/src/loader.ts` (`resolveEffectiveConfig`) for the API.

---

## Keeping this reference in sync with `schema/v1.json`

The JSON Schema at [`schema/v1.json`](../../schema/v1.json) is the source of
truth for types, defaults, and allowed values. This document is a
human-readable rendering of that schema. When the schema changes (new keys,
changed defaults, new enum values), this reference must be updated in the same
commit or PR.

### Checklist for schema changes

When modifying `schema/v1.json` or `packages/config/src/schema.ts`:

- [ ] Add or update the corresponding row(s) in the table(s) above.
- [ ] Update example YAML snippets if defaults or types changed.
- [ ] Run `review-agent config schema > schema/v1.json` to regenerate the
      committed schema file from the in-code Zod schema (spec §18.4):
      ```bash
      pnpm --filter @review-agent/cli build
      review-agent config schema > schema/v1.json
      ```
- [ ] Verify the schema file and this document agree: `review-agent config validate` against the example snippets in this page.
- [ ] Note the change in `UPGRADING.md` if the default or type of an existing key changed.

### IDE autocomplete

Add the following line to the top of any `.review-agent.yml` to enable IDE
validation and autocomplete (VS Code + YAML extension):

```yaml
# yaml-language-server: $schema=https://review-agent.dev/schema/v1.json
```

Or configure globally in VS Code `settings.json`:

```json
{
  "yaml.schemas": {
    "https://review-agent.dev/schema/v1.json": ".review-agent.yml"
  }
}
```
