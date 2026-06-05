# Self-hosted webhook server quickstart

The `@review-agent/server` Hono application receives GitHub webhooks and runs
reviews without consuming GitHub Action runner minutes. Use this when you want
always-on review at low latency or when your org does not want to grant Actions
access to your LLM API key.

> **Simplest path**: [docker-compose](../deployment/docker-compose.md) gets
> you running in one command. This page walks through the full setup end-to-end
> so you understand each step.

---

## Prerequisites

- Docker ≥ 24 + the Compose plugin (for the one-command path).
- A publicly reachable host (a VM, a cloud instance, or a tunnel — see
  [Networking](#networking) below).
- A GitHub App (or an existing one — see [GitHub App setup](#1-create-the-github-app)).
- An LLM API key (Anthropic default; any [supported provider](../providers/)
  works).

---

## 1. Create the GitHub App

1. Go to **github.com/settings/apps** (personal) or
   **github.com/organizations/\<org\>/settings/apps** (org-level).
2. Click **New GitHub App**.
3. Fill in:
   - **App name**: anything unique (e.g. `review-agent-yourdomain`)
   - **Webhook URL**: `https://<your-host>/webhook` (fill in after you know the
     host address)
   - **Webhook secret**: `$(openssl rand -hex 32)` — copy this value, you'll
     need it in the next step
4. Set **Permissions → Repository permissions**:
   - **Contents**: Read-only
   - **Pull requests**: Read & write
5. Subscribe to **Pull request** events.
6. Click **Create GitHub App**.
7. On the next screen, click **Generate a private key** and save the PEM file.

---

## 2. Install the App

From the App's settings page, click **Install App** and install it on the
repos (or the whole org) you want reviewed.

---

## 3. Start the server

```bash
# Clone the repo (skip if you already have it)
git clone https://github.com/almondoo/review-agent.git
cd review-agent/examples/docker-compose

# Generate secrets
mkdir -p secrets
cp ~/Downloads/your-app.private-key.pem secrets/github-app.pem
chmod 600 secrets/github-app.pem

# Create the env file
cp .env.example .env
```

Edit `.env` and set at minimum:

```dotenv
# Postgres
DB_PASSWORD=<openssl rand -base64 32>

# GitHub App
GITHUB_APP_ID=<from App settings page>
GITHUB_WEBHOOK_SECRET=<the secret you generated in step 1>
GITHUB_APP_PEM_FILE=./secrets/github-app.pem

# LLM provider (default: Anthropic)
ANTHROPIC_API_KEY=<from console.anthropic.com>
```

Bring up the stack:

```bash
docker compose up -d
```

Verify the server is healthy:

```bash
curl -fsS http://localhost:8080/healthz   # → ok
```

---

## 4. Set the webhook URL

Back in your GitHub App settings, set the **Webhook URL** to
`https://<your-host>/webhook`. GitHub will immediately send a `ping` event;
the server responds `200 OK`.

If your host is behind NAT, use a tunnel during setup:

```bash
ngrok http 8080
# Use the ngrok HTTPS URL as the webhook URL
```

---

## 5. Open a pull request

Open a PR on any repo where the App is installed. The server receives the
webhook, queues the job, and posts a review within 15–60 seconds (depending on
diff size and provider latency). Check the container logs if nothing appears:

```bash
docker compose logs -f review-agent
```

---

## Networking

| Situation | Solution |
|---|---|
| Cloud VM with public IP | Point your GitHub App webhook directly at `https://<ip>:8080` or better: put a reverse proxy (Caddy / nginx) in front for TLS termination |
| Home / NAT | `ngrok http 8080` or `tailscale funnel 8080` for a permanent tunnel |
| Corporate proxy | Configure `HTTPS_PROXY` in `.env`; the server uses the standard `node` proxy env |

GitHub only delivers webhooks to HTTPS endpoints (except on GHES with a
self-signed cert — see [ghes.md](../deployment/ghes.md)).

---

## Configuration

The server reads `.review-agent.yml` from the HEAD commit of each PR's
repository on every job. No volume mount is needed. Drop the file at your
repo root and it takes effect on the next PR.

For org-wide defaults, see [extends.md](../configuration/extends.md).

---

## Provider selection

The docker-compose example defaults to the Anthropic direct API. To switch:

| Provider | Change in `.env` |
|---|---|
| OpenAI | Add `OPENAI_API_KEY=...`; set `LLM_PROVIDER=openai` |
| Azure OpenAI | Add `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_DEPLOYMENT` |
| OpenAI-compatible (Ollama, vLLM) | Add `OPENAI_API_KEY=any-token`, `OPENAI_BASE_URL=http://...` |
| Bedrock / Vertex | Use [aws.md](../deployment/aws.md) / [gcp.md](../deployment/gcp.md) instead |

Full per-provider credential guides: [providers/](../providers/).

---

## See also

- [docker-compose self-host](../deployment/docker-compose.md) — the reference
  compose file with all options documented.
- [AWS deployment](../deployment/aws.md) — Lambda + SQS + RDS for production
  scale.
- [GCP deployment](../deployment/gcp.md) — Cloud Run + Pub/Sub + Cloud SQL.
- [Azure deployment](../deployment/azure.md) — Azure Container Apps + Service
  Bus + Azure Database for PostgreSQL.
- [Marketplace / Action](../deployment/marketplace.md) — publish + tag runbook.
- [GHES](../deployment/ghes.md) — GitHub Enterprise Server specifics.
- [Quickstart overview](./quickstart.md) — pick the right path for your setup.
