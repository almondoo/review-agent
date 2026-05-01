# GCP Cloud Run + Terraform — review-agent reference deployment

Receiver Cloud Run service + worker Cloud Run service + Pub/Sub
(topic + DLQ) + Cloud SQL Postgres 16 + Secret Manager + IAM (with
Vertex AI Anthropic by default).

For the narrative version, see
[`docs/deployment/gcp.md`](../../docs/deployment/gcp.md). The 16-section
breakdown lives there; this README is the operator-facing companion.

---

## 1. At a glance

- **Services**: Cloud Run × 2 (receiver + worker), Pub/Sub topic + DLQ,
  Cloud SQL Postgres 16, Secret Manager, IAM, Artifact Registry (you
  supply), Vertex AI (default LLM provider).
- **Monthly cost (us-central1, 2026 list prices)**:
  - **Low** (~50 PRs/mo): ~$30/mo (Cloud SQL `db-f1-micro` $9 +
    Cloud Run free tier covers the rest + Vertex Anthropic ~$15 +
    Secret Manager + Pub/Sub negligible).
  - **Typical** (200 PRs/mo): ~$70/mo.
  - **High** (1,000 PRs/mo, `db-perf-optimized-N-2`): ~$250/mo.
- **SLA**: Cloud Run + Pub/Sub + Cloud SQL all carry ≥ 99.95% Google
  SLAs. Vertex AI quotas vary by region — check before committing.
- **Scale**: solo team to mid-sized org. Cloud Run scales to many
  more concurrent requests than Lambda's pay-per-instance model;
  the worker's 60-min timeout (vs Lambda's 15 min) handles much
  larger PRs.

## 2. Architecture diagram

```
GitHub webhook
     │ HTTPS
     ▼
┌──────────────────────────┐
│ Cloud Run (receiver)      │
│  - HMAC verify §7.1       │
│  - idempotency check      │
│  - publish JobMessage     │
└──────────┬────────────────┘
           ▼
┌──────────────────────────┐         ┌──────────────────────┐
│ Pub/Sub topic            │ ──────► │ DLQ (alarm > 0)      │
│ review-agent-jobs        │         └──────────────────────┘
└──────────┬───────────────┘
           ▼ (push subscription, OIDC-authenticated)
┌──────────────────────────┐
│ Cloud Run (worker)        │──► Vertex AI (Anthropic Claude)
│ - clone (sparse)          │     (or Gemini direct, or external)
│ - runner + middleware     │──► GitHub API
│ - post comments           │──► Cloud SQL Postgres
│ - upsert review_state     │     (review_state, cost_ledger,
└──────────┬────────────────┘      audit_log, installation_secrets)
           │
           ▼
┌──────────────────────────┐
│ Secret Manager           │  ◄── webhook secret
│ - github-app-private-key │      App PEM
│ - anthropic-api-key      │      (only when llm_provider="anthropic")
│ - <name>-database-url    │
└──────────────────────────┘
```

## 3. Prerequisites

- `gcloud` CLI ≥ 487.0.0, Terraform ≥ 1.6, Docker.
- A GCP project with billing enabled. The module enables
  `run.googleapis.com`, `pubsub.googleapis.com`,
  `secretmanager.googleapis.com`, `sqladmin.googleapis.com`,
  `aiplatform.googleapis.com`, `iamcredentials.googleapis.com`,
  `cloudresourcemanager.googleapis.com`.
- A GitHub App (same setup as the AWS example).
- **Vertex AI**: model access for Anthropic Claude in your region —
  enable from the
  [Model Garden](https://console.cloud.google.com/vertex-ai/model-garden)
  and accept the Anthropic agreement once. Approval is instant for
  most accounts in 2026; first-time use may need a brief support
  exchange.
- An Artifact Registry repo for the worker image:
  `gcloud artifacts repositories create review-agent --repository-format=docker --location=<region>`.

## 4. Provider selection

Defaults to **Vertex AI Anthropic** because:

- Auth = SA on the worker. No API key.
- Billing rolls into your GCP bill alongside Cloud Run / Pub/Sub.
- Latency: same region as the worker.
- Compliance: Vertex contractually keeps prompts / completions
  outside Google's training pipelines.

Switch to:

- **Gemini direct** (`llm_provider = "google"`): cheaper if you're
  already in the Google AI Studio billing relationship; no Vertex
  permissions needed. Trade-off: weaker structured-output fidelity
  on the smaller Flash model.
- **External Anthropic** (`llm_provider = "anthropic"`): familiar
  if you're migrating from AWS or staying multi-cloud.

## 5. Step-by-step setup

| # | Action | Time |
|---|---|---|
| 1 | Create the GitHub App, download the PEM. | 10 min |
| 2 | `terraform init && terraform apply -target=...db -target=...pubsub`. | 10 min |
| 3 | Build + push the worker image to Artifact Registry. | 10 min |
| 4 | `terraform apply` (creates Cloud Run + IAM + Secret Manager scaffolding). | 5 min |
| 5 | Populate Secret Manager values (webhook + App PEM + optional Anthropic key). | 5 min |
| 6 | Paste the `webhook_url` output into the GitHub App. | 1 min |
| 7 | Open a draft PR; confirm the worker posts a review. | 5 min |

## 6. Terraform quickstart

```bash
cd examples/gcp-cloud-run-terraform
terraform init

cat > terraform.tfvars <<EOF
project_id    = "my-gcp-project"
region        = "us-central1"
github_app_id = "1234567"
image_uri     = "us-central1-docker.pkg.dev/my-gcp-project/review-agent/review-agent:0.3.0"
db_password   = "$(openssl rand -base64 32)"
EOF

terraform plan
terraform apply
```

Inputs you'll likely tweak:

| Variable | Default | When to change |
|---|---|---|
| `region` | `us-central1` | Vertex Anthropic available in `us-central1`, `us-east5`, `europe-west4` (2026). |
| `llm_provider` | `vertex` | `google` or `anthropic` to swap. |
| `vertex_model` | `claude-sonnet-4-6@anthropic` | Track new Anthropic Vertex IDs. |
| `db_tier` | `db-f1-micro` | Bump to `db-perf-optimized-N-2` past ~50 PRs/day. |
| `worker_max_instances` | 10 | Cap concurrent reviews. |

## 7. LLM provider setup (Vertex)

1. Open
   [Vertex AI Model Garden](https://console.cloud.google.com/vertex-ai/model-garden)
   in the project.
2. Find Anthropic Claude → *Enable*. Agree to the Anthropic provider
   terms (one-time per project).
3. The IAM policy this module attaches grants the worker SA
   `roles/aiplatform.user` on the project — sufficient for
   Anthropic + Gemini calls.
4. The worker reads `CLAUDE_CODE_USE_VERTEX=1` +
   `ANTHROPIC_VERTEX_PROJECT_ID` + `CLOUD_ML_REGION` from env, no
   further action needed.

For Gemini direct or external Anthropic, follow the AWS doc's
provider section — the env-var contract is identical.

## 8. Networking

- The receiver is `INGRESS_TRAFFIC_ALL` (public webhooks).
- The worker is `INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER` — only the
  Pub/Sub push subscription's OIDC-signed call reaches it.
- Cloud SQL is private (`ipv4_enabled = false`). The worker
  connects via Cloud SQL Auth Proxy mounted as
  `/cloudsql/<connection-name>`. The DATABASE_URL secret references
  that socket path.
- Egress (Vertex, GitHub API, OTel collector) traverses Google's
  network. No NAT required.

## 9. Cost control

- Cloud Run **min instances=0** for the receiver (idle = free) and
  the worker (KEDA-style scale-to-zero is built in via Pub/Sub
  push).
- Cloud SQL is the static line. Pause for dev environments or use
  Aurora-style serverless tiers when GA.
- `vertex_model = "claude-haiku-4-5-v1@anthropic"` cuts per-PR cost
  ~5× for projects that don't need Sonnet quality.
- Set a budget alert in GCP Billing scoped to this project.

## 10. Logging & observability

- **Cloud Logging** captures Cloud Run stdout/stderr automatically.
  Structured JSON logs from the worker turn into searchable fields.
- Set `otel_traces_endpoint` + `otel_headers` to forward spans to
  Langfuse / Honeycomb / Tempo. Body redaction is on by default
  (`langfuse_log_bodies = "0"`).
- For OTel via Cloud Trace directly, install the OTLP HTTP collector
  add-on; the chart's env passes through unchanged.

## 11. Backup & DR

- **Cloud SQL automated backups**: 14 days retention for `prod`,
  1 day otherwise. Point-in-time recovery enabled in `prod`.
- **Cross-region**: not provisioned by this module. Enable via
  `replica_configuration` on a read replica, or use
  `gcloud sql instances clone` for periodic copies.
- **Secret Manager** keeps prior versions; rotate using
  `gcloud secrets versions add`.
- **Pub/Sub DLQ** retention: 14 days.

**RPO / RTO** target: 5 min RPO (Cloud SQL continuous backups),
15 min RTO (`terraform apply` against a known image + Cloud SQL
PITR).

## 12. Security hardening checklist

- [ ] **Security Command Center** enabled on the project.
- [ ] **VPC Service Controls** perimeter around the project for
      data-egress denial outside Google APIs.
- [ ] **Binary Authorization** policy attached to the Cloud Run
      services pinning the image to cosign-keyless-signed builds.
- [ ] **Workload Identity Federation** for cross-cloud secret
      access (when applicable).
- [ ] **Quarterly secret rotation** for webhook + App PEM.
- [ ] **Cloud Armor** in front of the receiver if you want WAF.

## 13. Upgrade procedure

```bash
gcloud auth configure-docker us-central1-docker.pkg.dev
VERSION=0.3.1
docker build -t review-agent:$VERSION .
docker tag review-agent:$VERSION us-central1-docker.pkg.dev/<project>/review-agent/review-agent:$VERSION
docker push us-central1-docker.pkg.dev/<project>/review-agent/review-agent:$VERSION

sed -i.bak "s|image_uri.*|image_uri = \"us-central1-docker.pkg.dev/<project>/review-agent/review-agent:$VERSION\"|" terraform.tfvars
terraform apply
```

Cloud Run does revision-based rollout — new traffic flows to the
fresh revision; in-flight requests on old revisions complete.

## 14. Cleanup / teardown

```bash
terraform destroy
```

Manual residue:

- **Artifact Registry repo**: `gcloud artifacts repositories delete review-agent --location=<region>`.
- **GitHub App webhook URL**: clear or uninstall.
- **Anthropic API key** (if used): revoke in console.anthropic.com.
- **Cloud SQL**: deletion protection is on for `prod`; flip and
  re-destroy.

## 15. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `terraform apply` fails with `serviceUsageConsumer` denied | Project number not allowed to enable APIs | Re-run as a project Owner / `roles/serviceusage.serviceUsageAdmin`. |
| Pub/Sub push delivery 401 | OIDC audience mismatch | The audience must equal the worker's URL. The module wires this; double-check after a `worker_url` output change. |
| Receiver returns 401 on every webhook | Webhook secret mismatch | `gcloud secrets versions add review-agent-github-webhook-secret --data-file=-` then redeploy. |
| Worker logs `permission denied for project ... aiplatform` | Vertex model access not approved | Approve in the Model Garden console; the IAM role is already attached. |
| `Cloud SQL: connection refused` | Cloud SQL Auth Proxy mount missing | Confirm `volume_mounts` block in `worker` Cloud Run service points at `/cloudsql/<connection-name>`. |
| Pub/Sub backlog grows without delivery | Worker ack-deadline mismatch | Bump `var.ack_deadline_seconds`; pair with worker timeout. |
| Cold-start > 8s | Container image too large | Run `pnpm prune --prod` in the runtime stage of the Dockerfile. |

## 16. References

- [`docs/deployment/gcp.md`](../../docs/deployment/gcp.md) — narrative form.
- Spec §15.3 — GCP Cloud Run + Pub/Sub reference deploy.
- Spec §18.3 — per-cloud README outline.
- [Cloud Run + Pub/Sub push integration](https://cloud.google.com/run/docs/triggering/pubsub-push)
- [Vertex AI Anthropic](https://docs.anthropic.com/en/api/claude-on-vertex-ai)
- [Cloud SQL Auth Proxy](https://cloud.google.com/sql/docs/postgres/connect-auth-proxy)
