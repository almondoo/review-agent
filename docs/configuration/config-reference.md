# `.review-agent.yml` Configuration Reference

Every key is optional. Omitted keys take the documented default.
The YAML file lives at the repository root (`.review-agent.yml`).
Org-central config lives in `<org>/.github/review-agent.yml`.

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
| `reviews.path_filters` | string[] | `[]` | repo, org | Glob patterns to exclude from review. Prefix with `!` (e.g. `!dist/**`). Org + repo lists are concatenated. |
| `reviews.path_instructions` | array | `[]` | repo, org | Per-path agent instructions. See [path-instructions.md](./path-instructions.md). |
| `reviews.max_files` | positive integer | `50` | repo, org | Hard cap on files reviewed per PR. PRs exceeding this are skipped with a summary comment. |
| `reviews.max_diff_lines` | positive integer | `3000` | repo, org | Hard cap on diff lines reviewed per PR. |
| `reviews.ignore_authors` | string[] | `['dependabot[bot]', 'renovate[bot]', 'github-actions[bot]']` | repo, org | Skip review for PRs authored by these logins. Org + repo lists are concatenated. |
| `reviews.min_confidence` | `'high'` \| `'medium'` \| `'low'` | `'low'` | repo, org | Suppress comments whose model confidence is strictly below this value. `low` = post everything. Comments with no confidence field are treated as `'high'`. |
| `reviews.request_changes_on` | `'critical'` \| `'major'` \| `'never'` | `'critical'` | repo, org | Severity threshold at which the reviewer posts `REQUEST_CHANGES` instead of `COMMENT`. `never` = always post `COMMENT`. |

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
| `skills` | string[] | `[]` | repo, org | Skill file paths or npm-distributed skill package names (e.g. `@review-agent/skill-owasp-top10`). Org + repo lists are concatenated. See [Skills docs](../getting-started/). |

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
