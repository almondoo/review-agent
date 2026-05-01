# Self-host with docker-compose

Single-node `review-agent` stack on any host that can run Docker:
container, Postgres, ElasticMQ, optional Langfuse. This is the
simplest deployment — appropriate for one developer or a small team
on a single VM. For multi-tenant production, use one of the cloud
examples instead.

Spec references: §15.2, §15.6.6, §17.1, §18.3 (subset).

---

## 1. At a glance

- **Services**: `review-agent` (single process), `db` (Postgres 16),
  `elasticmq` (SQS-compatible local queue). Optional Langfuse via
  `--profile telemetry`.
- **Cost**: free except for Anthropic / OpenAI usage and the host VM.
- **Scale**: one host, low-volume PR review (≤ ~30 PRs/day). Beyond
  that, run on AWS / GCP / Azure with a real queue.
- **Suitable for**: solo developers, homelab installs, evaluation
  before committing to a cloud deployment.

## 2. Architecture

GitHub posts webhooks to `http://<host>:8080/webhook`. The single
container runs the receiver + worker in-process: the receiver verifies
the HMAC signature and pushes to ElasticMQ; the worker dequeues and
runs the review pipeline. State + cost ledger + audit log live in the
embedded Postgres.

```
┌──────────────────────────┐
│ GitHub webhook           │ HTTPS  ┌──────────────────────────┐
│  (POST /webhook)         │ ─────► │ review-agent container    │
└──────────────────────────┘        │  - receiver (Hono)        │
                                    │  - worker (in-process)    │
                                    │  - secret-scan (gitleaks) │
                                    └──┬───────────────────┬────┘
                                       │                   │
                                       ▼                   ▼
                          ┌─────────────────┐   ┌─────────────────┐
                          │ ElasticMQ       │   │ Postgres 16     │
                          │ jobs queue+DLQ  │   │ review_state    │
                          └─────────────────┘   │ cost_ledger     │
                                                │ audit_log       │
                                                └─────────────────┘
```

## 3. Prerequisites

- Docker ≥ 24 + the Compose plugin.
- A publicly reachable host (or a tunnel — see §15 troubleshooting).
- A GitHub App with `Pull requests: Read & Write` (and the
  permissions listed in `docs/deployment/aws.md` § 5.1) installed on
  the target repos.
- An Anthropic API key (or another provider — swap the env vars per
  `docs/security/byok.md`).

## 4. Provider selection

Defaults to **Anthropic via direct API**. Reasons:

- Single-node deploys aren't running on a cloud, so cloud-native
  endpoints (Bedrock / Vertex / Azure OpenAI) require extra credential
  setup that doesn't fit this stack.
- BYOK / KMS envelope encryption is **not** wired in this example —
  it depends on a real KMS instance. If you need per-installation
  isolation, deploy on AWS instead (see `docs/deployment/aws.md`).

You can swap providers by changing `ANTHROPIC_API_KEY` to an
`OPENAI_API_KEY` (or any other) and overriding the provider in
`.review-agent.yml` per repo.

## 5. Step-by-step setup

```bash
cd examples/docker-compose

# 1. Generate secrets
mkdir -p secrets
# Drop your GitHub App PEM at ./secrets/github-app.pem (chmod 600).
cp ~/Downloads/your-app.private-key.pem secrets/github-app.pem
chmod 600 secrets/github-app.pem

# 2. Author the .env file
cp .env.example .env
${EDITOR:-vi} .env
#   - DB_PASSWORD: openssl rand -base64 32
#   - GITHUB_APP_ID: from GitHub App settings
#   - GITHUB_WEBHOOK_SECRET: openssl rand -hex 32
#   - GITHUB_APP_PEM_FILE: ./secrets/github-app.pem
#   - ANTHROPIC_API_KEY: from console.anthropic.com

# 3. Bring up
docker compose up -d

# 4. Verify
curl -fsS http://localhost:8080/healthz   # → ok
docker compose logs -f review-agent

# 5. Wire the webhook URL on the GitHub App side:
#    https://<your-host>/webhook
#    Same secret as GITHUB_WEBHOOK_SECRET.
```

## 6. Configuration reference

Every service-level setting lives in `docker-compose.yml`. The
`.env.example` documents every input the compose file consumes.
Production overrides:

- Set `REVIEW_AGENT_VERSION=0.3.0` (or whichever release tag) in
  `.env` to pin against a specific image rather than `:latest`.
- Mount your repo's `.review-agent.yml` into the container as a
  read-only volume if you want it picked up at the worker level —
  not strictly necessary because the worker fetches it from the PR's
  HEAD commit on every job.
- Override `WEBHOOK_PORT` if `:8080` is taken on the host.

## 7. LLM provider setup

Direct Anthropic API is the default. To swap:

| Provider | What to change |
|---|---|
| OpenAI | Add `OPENAI_API_KEY=...` to `.env`; set `LLM_PROVIDER=openai` (override env var read by the worker); per-repo `.review-agent.yml` should set `provider.type: openai`. |
| Azure OpenAI | Add `AZURE_OPENAI_API_KEY` + `AZURE_OPENAI_ENDPOINT` + `AZURE_OPENAI_DEPLOYMENT`. |
| OpenAI-compatible (Ollama, vLLM, OpenRouter) | Set `OPENAI_API_KEY` (any string the endpoint accepts) + `OPENAI_BASE_URL` to the local endpoint. |
| Bedrock / Vertex | Use the AWS or GCP example deployments instead — the compose stack doesn't wire cloud credentials. |

## 8. Networking

- The container exposes port 8080 on the host. Anything reaching
  that port reaches the receiver. Pair with a reverse proxy
  (Caddy / nginx / Traefik) that terminates TLS — GitHub will not
  deliver webhooks to a plain-HTTP URL except via an explicit tunnel.
- Egress: the container reaches api.github.com, the LLM provider's
  HTTPS endpoint, and the OTel collector if configured.
- Internal network: only the docker-compose default bridge. ElasticMQ
  and Postgres are not exposed to the host (no `ports:` mapping
  except for ElasticMQ's web UI on `:9325`, which you can drop).

## 9. Cost control

- `cost.max_usd_per_pr` and `cost.daily_cap_usd` in
  `.review-agent.yml` provide per-PR + per-day ceilings (spec §8.5).
- Provider-side spend caps via the provider's billing console
  (Anthropic Workspace daily limit, OpenAI hard cap, etc.).
- The cost ledger in Postgres makes runaway spend visible:
  ```sql
  SELECT date, SUM(cost_usd) FROM cost_ledger
  GROUP BY date ORDER BY date DESC LIMIT 7;
  ```

## 10. Logging & observability

- Container logs: `docker compose logs review-agent`. The receiver
  + worker emit structured JSON.
- For tracing, bring up the bundled Langfuse stack:
  ```bash
  cp .env.example .env  # ensure LANGFUSE_* vars are set
  docker compose --profile telemetry up -d
  ```
  Then point the receiver at it (uncomment in `.env`):
  ```bash
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://langfuse:3000/api/public/otel/v1/traces
  OTEL_EXPORTER_OTLP_HEADERS=Authorization=Basic <basic-auth-from-langfuse-ui>
  ```
- See `docs/architecture/observability.md` for the full span +
  metric set and the body-redaction defaults.

## 11. Backup & DR

- `docker compose stop review-agent && pg_dump -h localhost -U review_agent review_agent > backup.sql`
- `db-data` volume holds the Postgres data dir. Snapshot the
  underlying disk for whole-DB recovery.
- The DLQ retains failed jobs for 14 days (ElasticMQ default) — drain
  with `aws --endpoint-url http://localhost:9324 sqs receive-message ...`.

For production-grade DR, deploy on a cloud — RDS automated backups +
multi-AZ are not replicable on a single host.

## 12. Security hardening

- [ ] PEM file owned by root, mode `0400`, mounted read-only.
- [ ] `.env` not committed (the example's `.gitignore` covers this).
- [ ] Reverse proxy enforces TLS + a WAF / IP allow-list if exposed
      on the public internet.
- [ ] OS-level firewall denies inbound `:9324` (ElasticMQ API) and
      `:9325` (UI) from the public internet.
- [ ] `docker compose pull` on a schedule + restart to pick up image
      patches.

## 13. Upgrade procedure

```bash
docker compose pull review-agent
docker compose up -d
```

The `restart: unless-stopped` policy plus the healthcheck means the
new container takes over without downtime once it reports healthy.

## 14. Cleanup

```bash
docker compose down            # stop + remove containers
docker compose down -v         # also drops the db-data volume — destructive
rm -rf secrets .env
```

Then revoke the GitHub App webhook URL or uninstall the App.

## 15. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Webhook returns 401 | Secret mismatch | `.env`'s `GITHUB_WEBHOOK_SECRET` must equal the App's webhook secret. Restart after editing. |
| Webhook reaches host but compose container 502 | Reverse proxy not forwarding to `:8080` | Confirm `docker compose ps` shows port mapping; check proxy backend. |
| `db is not healthy` on first start | First-run init takes longer than the default healthcheck retries | Wait 30s; if persistent, raise `retries:` on the db service. |
| `permission denied` reading `/run/secrets/github_app_pem` | PEM file not chmod 0400 / owner not 1000 | `chmod 600 secrets/github-app.pem` on the host (the container runs as 1000 but Docker's secret subsystem normalizes ownership). |
| Webhook delivers but no review posts | Worker crash before SQS ack | `docker compose logs review-agent` for the stack trace; common cause is missing `ANTHROPIC_API_KEY`. |
| Behind NAT / no public IP | Host not reachable by GitHub | Use `ngrok http 8080` or `tailscale funnel 8080`; document the URL in your GitHub App webhook config. |
| Image pull rate-limited from GHCR | GHCR anonymous pull limits | `docker login ghcr.io` with a personal access token. |

## 16. References

- Spec §15.2 — docker-compose reference deploy.
- Spec §17.1 — data flow disclosure.
- `docs/architecture/observability.md` — OTel setup.
- `docs/security/byok.md` — multi-tenant key isolation (not used by
  this example, but worth reading before considering production).
