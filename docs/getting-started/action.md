# GitHub Action quickstart

`review-agent` runs as a GitHub Action in your CI pipeline. Every time a
pull request is opened or updated, it posts inline comments and a summary
review using your own LLM API key (BYOK — Bring Your Own Key). No data
leaves your configured LLM provider.

For the production **webhook server** (no GitHub Action runner required),
see [self-host with docker compose](../deployment/docker-compose.md). For
the command-line interface, see [CLI](./cli.md).

---

## 1. Copy the workflow template

Copy
[`examples/workflows/review-agent.yml`](../../examples/workflows/review-agent.yml)
into your repository:

```bash
# From your repository root:
mkdir -p .github/workflows
curl -sSL \
  https://raw.githubusercontent.com/almondoo/review-agent/main/examples/workflows/review-agent.yml \
  > .github/workflows/review-agent.yml
```

Or copy it manually — the file is a self-contained, heavily commented
YAML template that works as-is.

## 2. Add your API key as a repository secret

1. Go to **Settings → Secrets and variables → Actions** in your
   repository.
2. Click **New repository secret**.
3. Name: `ANTHROPIC_API_KEY`. Value: your key from
   [console.anthropic.com](https://console.anthropic.com).
4. Click **Add secret**.

The `github-token` input defaults to the built-in `secrets.GITHUB_TOKEN`
(scoped to the current run) — you do not need to set it separately.

## 3. Open a pull request

Push a branch, open a PR, and review-agent posts comments automatically.
The first review may take 15–30 seconds depending on diff size.

---

## Configuration (optional)

Drop a `.review-agent.yml` at your repository root to customise
behaviour. Every field is optional:

```yaml
language: en-US          # review comment language (BCP-47)
profile: chill           # chill | assertive
reviews:
  ignore_authors:
    - dependabot[bot]
    - renovate[bot]
```

Full schema reference: [`schema/v1.json`](../../schema/v1.json).

---

## Permissions

The template requests the minimum set required:

| Permission | Level | Why |
|---|---|---|
| `contents` | `read` | Sparse-clone the changed paths for tool calls |
| `pull-requests` | `write` | Post inline comments + summary review |

No `issues: write` permission is needed for the Action.

---

## Pinning strategy

The template uses `almondoo/review-agent@v1`, which always tracks the
latest v1.x release. For tighter control:

| Pin | Meaning |
|---|---|
| `@v1` | Latest stable v1 (recommended) |
| `@v1.2` | Latest v1.2.x patch |
| `@v1.2.3` | Exact immutable release |

See [Marketplace & tag runbook](../deployment/marketplace.md) for the
full tag management strategy.

---

## Marketplace listing

The Action is published to the
[GitHub Actions Marketplace](https://github.com/marketplace/actions/review-agent).
Search for **review-agent** to install it directly from the Marketplace UI.

---

## See also

- [CLI](./cli.md) — local trial and pre-commit gate
- [docker compose self-host](../deployment/docker-compose.md) — full
  self-hosted server stack (no Action runner required)
- [Marketplace runbook](../deployment/marketplace.md) — tag strategy and
  Marketplace publish steps
