# Org-wide config: `<org>/.github/review-agent.yml`

By default each repository in your installation reads its own
`.review-agent.yml`. For org-wide standards (mandatory ignore-author
list, shared skill bundle, single budget cap), drop a file at
`<org>/.github/review-agent.yml` — the same `.github` repo GitHub
uses for org-level community health files.

This document covers how the org config interacts with the per-repo
config: when it's silently inherited, how `extends: org` lets a repo
explicitly merge with it, and how list fields are concatenated rather
than replaced.

Spec reference: §10.2 (config precedence layer 3).

---

## How precedence works

```
1. CLI / env overrides (REVIEW_AGENT_LANGUAGE, --lang flag, ...)
2. Per-repo .review-agent.yml             (silent default)
3. Org config <owner>/.github/review-agent.yml
4. Built-in defaults (zod schema)
```

The resolver in `@review-agent/config`'s `loadConfigWithOrgFallback`
walks these layers as follows:

| Repo `.review-agent.yml` | `extends: org` set | What loads |
|---|---|---|
| Present | No | Repo only. Org file is **not** fetched. |
| Present | Yes | Org → Repo merged (repo wins on scalars; lists concatenated). |
| Missing | — | Org as silent fallback. |
| Missing & org missing | — | Schema defaults. |

The `extends: org` keyword is opt-in — a repo does **not** inherit
the org config without it. This matches operator expectations: the
org file is "guidance everyone falls back to" rather than a hidden
override that ships across repo boundaries.

## Merge rules

When `extends: org` triggers a merge:

| Field type | Behaviour |
|---|---|
| Scalar (`language`, `profile`, `cost.max_usd_per_pr`, ...) | **Repo wins.** Org provides the floor; repo can raise / lower freely. |
| Nested object (`reviews.auto_review`, `cost`, ...) | Shallow merge, repo keys win. |
| `provider` (single object) | Repo wins entirely. Set on repo only when you want a per-repo override. |
| List (`skills`, `reviews.path_filters`, `reviews.path_instructions`, ...) | **Concatenated** — org first, then repo. Downstream code (skill loader, glob matcher) handles duplicate entries. |
| `reviews.ignore_authors`, `privacy.allowed_url_prefixes`, `privacy.deny_paths` | Concatenated **and de-duplicated** — these are sets in spirit. |

Why concat instead of replace? The intent of `extends: org` is "I want
the org defaults *plus* my repo's additions" — replacing would
silently drop the org's policy, which is the exact bug `extends: org`
exists to prevent.

## Caching

The fetcher caches the raw YAML text per `(owner, file)` for **5
minutes by default** (configurable via `OrgConfigCacheOpts.ttlMs`).
Negative results (`null` for missing file) are cached too — we don't
hammer the GitHub API every webhook.

To force a refresh after editing the org file:

```ts
import { createOrgConfigCache } from '@review-agent/config';

const cache = createOrgConfigCache(fetch, { ttlMs: 5 * 60 * 1000 });
cache.invalidate('acme');     // refresh just acme
cache.invalidate();           // refresh everyone
```

The webhook server keeps the cache instance per process. Lambda cold
starts get a fresh cache; warm Lambda containers reuse it for the
container's lifetime.

## Examples

### Org-wide ignore list

`acme/.github/review-agent.yml`:

```yaml
reviews:
  ignore_authors:
    - dependabot[bot]
    - renovate[bot]
    - acme-bot
skills:
  - acme/security-baseline
cost:
  max_usd_per_pr: 0.50
```

`acme/payments-service/.review-agent.yml`:

```yaml
extends: org
reviews:
  ignore_authors:
    - payments-bot
skills:
  - payments/pii-redaction-rules
```

Effective config for the `payments-service` repo:

- `reviews.ignore_authors` =
  `['dependabot[bot]', 'renovate[bot]', 'acme-bot', 'payments-bot']` (deduped).
- `skills` =
  `['acme/security-baseline', 'payments/pii-redaction-rules']`.
- `cost.max_usd_per_pr` = `0.50` (inherited from org; not overridden).

### Repo without `extends`

```yaml
# acme/quick-experiment/.review-agent.yml
language: ja-JP
profile: chill
```

The org file is **not consulted**. The repo gets `language: ja-JP` +
schema defaults for everything else, even if `acme/.github/review-agent.yml`
sets a stricter `cost.max_usd_per_pr`.

### Repo opts out of org with explicit `extends: null`

```yaml
extends: null
profile: assertive
```

Equivalent to omitting `extends`. Useful when you want to make the
opt-out explicit in the diff history.

## Cross-org / fork behaviour

For a fork in `acme-fork/payments-service`, the org config is read
from `acme-fork/.github/review-agent.yml` — **not** `acme`'s. This
matches the GitHub App's installation boundary: the App runs against
the org that installed it, not the upstream.

If you want a fork to inherit upstream's org config, copy the file
into the fork's `.github` repo. We don't follow `parent` links on
purpose — the App is scoped to one installation, and reading config
from a different account is a privilege escalation we won't do
silently.

## CodeCommit

CodeCommit has no `.github` equivalent and the adapter is intentionally
narrow (`@review-agent/platform-codecommit` is read-only on
configuration). Org-wide config for CodeCommit deployments is
**not supported in v0.3**. Use environment variable overrides
(`REVIEW_AGENT_LANGUAGE`, `REVIEW_AGENT_MAX_USD_PER_PR`, ...) to
apply org-wide policy at the worker process level instead.

## Wiring (server example)

```ts
import {
  createOrgConfigCache,
  loadConfigWithOrgFallback,
} from '@review-agent/config';
import { createGithubOrgConfigFetch } from '@review-agent/platform-github';

// In webhook setup, once per process:
const orgConfigCache = createOrgConfigCache(
  createGithubOrgConfigFetch({ octokit }),
  { ttlMs: 5 * 60 * 1000 },
);

// Per job:
const repoYaml = await readRepoConfigFromCheckout(...);   // string | null
const { config, source } = await loadConfigWithOrgFallback({
  owner: job.prRef.owner,
  repoYaml,
  orgConfigCache,
});
metrics.configSourceTotal.add(1, { source });             // observability
```

## Operational checklist

- [ ] Org config committed to `<org>/.github/review-agent.yml`
      (default repo + path, no GitHub App permission changes needed).
- [ ] Per-repo configs that want to inherit add `extends: org`
      explicitly.
- [ ] Repos that fail validation surface the error early — Zod's
      structural check runs after the merge; bad list entries reject
      the whole config.
- [ ] Documented in your org's onboarding handbook so engineers know
      they can override scalars freely but lists are additive.
- [ ] `cost.max_usd_per_pr` and `cost.daily_cap_usd` are explicitly
      set in the org file as the org-wide ceiling. Repos can lower
      these per repo, never raise them silently — encode that in
      your CI policy if it matters.
