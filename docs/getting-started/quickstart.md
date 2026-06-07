# Quickstart — zero to first review in 10 minutes

Pick the path that matches your setup:

| Path | Best for | Time |
|---|---|---|
| [A. CLI trial (no GitHub needed)](#a-cli-trial-no-github-needed) | First-time evaluation, pre-commit gate | ~3 min |
| [B. GitHub Action](#b-github-action) | CI-integrated review on every PR, no server required | ~5 min |
| [C. Self-hosted webhook server](#c-self-hosted-webhook-server) | Always-on review without GitHub Action runner minutes | ~10 min |

---

## A. CLI trial (no GitHub needed)

**Requires**: `pnpm`, an Anthropic API key (or any supported provider key).

```bash
# Install from the workspace (the package is not yet published to npm)
pnpm install
pnpm --filter @review-agent/cli build
pnpm link --global --filter @review-agent/cli

# Run the bundled sample diff — no git repo, no GitHub token needed
ANTHROPIC_API_KEY=sk-ant-... review-agent review --sample
```

The sample diff contains intentional security, bug, and performance issues.
The agent prints findings to stdout. No GitHub credentials are required.

Once satisfied, run it against your own uncommitted changes:

```bash
review-agent review --local
```

Full CLI reference: [cli.md](./cli.md).

---

## B. GitHub Action

**Requires**: a GitHub repository, an Anthropic API key.

### 1. Add the workflow

```bash
mkdir -p .github/workflows
curl -sSL \
  https://raw.githubusercontent.com/almondoo/review-agent/main/examples/workflows/review-agent.yml \
  > .github/workflows/review-agent.yml
```

### 2. Add the secret

Go to **Settings → Secrets and variables → Actions → New repository secret**:

- Name: `ANTHROPIC_API_KEY`
- Value: your key from [console.anthropic.com](https://console.anthropic.com)

### 3. Open a pull request

Push a branch, open a PR. Review-agent posts inline comments automatically.
The first review typically takes 15–30 seconds.

Full Action reference: [action.md](./action.md).

---

## C. Self-hosted webhook server

**Requires**: Docker, a GitHub App, an API key, a publicly reachable host.

```bash
cd examples/docker-compose
cp .env.example .env
# Edit .env: DB_PASSWORD, GITHUB_APP_ID, GITHUB_WEBHOOK_SECRET,
#             GITHUB_APP_PEM_FILE, ANTHROPIC_API_KEY
docker compose up -d
curl -fsS http://localhost:8080/healthz   # → ok
```

Then set the webhook URL on your GitHub App to `https://<host>/webhook`.

Full server setup guide: [server.md](./server.md).

---

## What's next?

- **Config**: drop a `.review-agent.yml` at your repo root to tune language,
  profile, cost caps, and ruleset. Full reference:
  [config-reference.md](../configuration/config-reference.md).
- **Providers**: switch from Anthropic to OpenAI, Azure, Vertex, Bedrock, or a
  local model. See the [providers](../providers/) directory.
- **Presets**: extend a bundled preset instead of configuring from scratch.
  See [extends.md](../configuration/extends.md).
- **Skills**: teach the agent domain-specific review rules.
  See [skills.md](./skills.md).
