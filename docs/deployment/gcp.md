# Deploying review-agent on GCP (Cloud Run + Pub/Sub + Cloud SQL)

Cloud Run receiver + Cloud Run worker + Pub/Sub topic + DLQ + Cloud
SQL Postgres 16 + Secret Manager. Vertex AI Anthropic by default.

This is the long-form companion to
[`examples/gcp-cloud-run-terraform/`](../../examples/gcp-cloud-run-terraform/).
The 16-section breakdown below maps 1:1 to the §18.3 outline. The
operational steps + Terraform input reference live in the example
README; this doc covers the *why* + the GCP-specific bits.

Spec references: §15.3, §15.6.6, §18.3, §8.5, §17.1.

---

## 1. At a glance

- **Compute**: 2× Cloud Run service. Receiver scales to 5; worker
  scales to 10 by default.
- **Queue**: Pub/Sub topic with a push subscription that targets the
  worker via OIDC-authenticated calls.
- **Database**: Cloud SQL Postgres 16, IAM-auth enabled, private IP
  only.
- **LLM provider**: Vertex AI Anthropic by default — same auth model
  as Bedrock on AWS. Gemini direct + external Anthropic also wired.
- **Webhook URL**: Cloud Run service URL (or domain mapping).
- **Cost**: ~$30–$250/mo depending on PR volume; see the example
  README § 1.
- **Suitable for**: solo developers through mid-sized orgs. Cloud
  Run's per-instance scaling + 60-min request timeout (vs Lambda's
  15) handle larger PRs without a Step Functions equivalent.

## 2. Architecture

GitHub posts to the receiver Cloud Run service. The receiver
verifies the signature, idempotency-checks the delivery, and
publishes a `JobMessage` to Pub/Sub. The push subscription invokes
the worker Cloud Run service over OIDC-authenticated HTTPS. The
worker fetches the diff, runs the review pipeline, and posts
comments back. Postgres holds the review state, cost ledger, audit
log, and (when BYOK is enabled) installation-secrets envelope blobs.

The same container image runs both services — `image_config.command`
selects the entrypoint. This keeps the Artifact Registry footprint
small and the rollout story uniform.

## 3. Prerequisites

- `gcloud` ≥ 487.0.0, Terraform ≥ 1.6, Docker.
- A GCP project with billing enabled.
- A GitHub App created in your org's
  *Settings → Developer settings → GitHub Apps* with the same
  permissions as the AWS deployment (PR + Issues + Contents).
- **Vertex AI Anthropic** enabled in the
  [Model Garden](https://console.cloud.google.com/vertex-ai/model-garden)
  for your `var.region`. One-time approval per project.
- An Artifact Registry Docker repo named `review-agent`.

## 4. Provider selection

Default: **Vertex AI Anthropic Claude**. Reasons:

- Auth is the worker's service account — no API key to manage or
  rotate.
- Billing rolls into the same GCP project, so finance dashboards
  already cover it.
- Latency: same region as the worker.
- Compliance: Vertex contractually keeps prompts / completions out
  of training pipelines.

Switch to:

- `llm_provider = "google"` (Gemini direct via AI Studio): cheapest
  for orgs already paying Google AI Studio. Trade-off — Gemini Flash
  has weaker structured-output adherence on the smaller models.
- `llm_provider = "anthropic"`: external Anthropic API. Useful when
  migrating from AWS or running multi-cloud.

## 5. Step-by-step setup

See [`examples/gcp-cloud-run-terraform/README.md`](../../examples/gcp-cloud-run-terraform/README.md)
§ 5 for the seven-step bring-up checklist + the exact shell
commands.

## 6. Terraform inputs reference

See `examples/gcp-cloud-run-terraform/variables.tf` — every input
has an inline description + (for enums) `validation` blocks.

## 7. LLM provider setup

### 7.1 Vertex (default)

1. Open
   [Vertex AI Model Garden](https://console.cloud.google.com/vertex-ai/model-garden)
   in the project.
2. Find Anthropic Claude → *Enable*. Accept the Anthropic agreement.
3. Approval is instant in 2026 for most accounts. The IAM role
   `roles/aiplatform.user` is attached to the worker SA by this
   module.

### 7.2 Gemini direct (Google AI Studio)

Set `llm_provider = "google"` and create a GOOGLE_GENERATIVE_AI_API_KEY
in Secret Manager (the chart wiring uses it via env). The Vertex
permissions in §7.1 are unnecessary in this mode.

### 7.3 External Anthropic

Set `llm_provider = "anthropic"`, `terraform apply`, then populate
the Anthropic API key secret per §5.3 in the example README.

**Recommended onboarding**: run `review-agent setup workspace` (CLI)
to create the Workspace, enable ZDR, and set a monthly spend cap
before populating the secret. Default mode prints a manual
checklist; `--api` calls the Admin API directly (requires
`ANTHROPIC_ADMIN_KEY`).

## 8. Networking

- **Receiver** ingress: `INGRESS_TRAFFIC_ALL` (public). HMAC verify
  is the gate.
- **Worker** ingress:
  `INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER` — only the Pub/Sub push
  subscription's OIDC-signed call reaches it.
- **Cloud SQL**: private IP only. Worker connects via the Cloud SQL
  Auth Proxy mounted at `/cloudsql/<connection-name>`.
- **Egress**: all Google APIs traverse Google's network without NAT.
  GitHub API + OTel collector go through the project's default
  routing.

For stricter posture: **VPC Service Controls** perimeter the project
so even a compromised worker cannot reach `storage.googleapis.com`
or `bigquery.googleapis.com` outside the perimeter.

## 9. Cost control

| Lever | Where | Effect |
|---|---|---|
| `vertex_model = claude-haiku-4-5-v1@anthropic` | tfvars | ~5× per-PR cost cut for the haiku tier. |
| `worker_max_instances` | tfvars | Cap concurrent reviews → cap concurrent token spend. |
| Cloud Run **min instances=0** | always-on | Idle = free; cold-start ~600ms is acceptable for webhook lag. |
| Cloud SQL `db-f1-micro` | tfvars `db_tier` | Tiny instance, fine until ~50 PRs/day. |
| Project-level **GCP Billing budget** alert | Billing console | Daily / monthly threshold notifications. |

The cost-ledger queries documented in `docs/cost/index.md` work
identically on Cloud SQL as on RDS.

## 10. Logging & observability

- Cloud Logging: every Cloud Run revision logs structured JSON to
  the project's default sink. Filter on
  `resource.labels.service_name="review-agent-receiver"` etc.
- OTel: set `otel_traces_endpoint` + `otel_headers` to forward
  spans (Langfuse / Honeycomb / Tempo). Body redaction is on by
  default (`langfuse_log_bodies = "0"`).
- Cloud Trace as the OTel backend is also viable — the worker's
  OTLP HTTP exporter can target Cloud Trace via the
  `cloud-trace-otlp-collector`.

## 11. Backup & DR

- **Cloud SQL automated backups**: 14 days for `prod`, 1 day
  otherwise. Point-in-time recovery on for `prod`.
- **Cross-region read replica**: not provisioned in this module.
  Enable via `replica_configuration` on a sibling instance, or use
  scheduled `gcloud sql instances clone` for periodic copies.
- **Secret Manager** keeps every prior version (no auto-purge).
  Rotate via `gcloud secrets versions add`.
- **Pub/Sub DLQ** retention: 14 days.

**RPO / RTO**: 5 min RPO (Cloud SQL continuous backups), 15 min RTO
(`terraform apply` against a known image + Cloud SQL PITR).

## 12. Security hardening checklist

- [ ] **Security Command Center** enabled at project / org scope.
- [ ] **VPC Service Controls** perimeter around the project.
- [ ] **Binary Authorization** Cloud Run policy pinning the image
      to cosign-keyless-signed builds (spec §15.6.3).
- [ ] **Workload Identity Federation** for cross-cloud access.
- [ ] **Quarterly secret rotation** for webhook + App PEM.
- [ ] **Cloud Armor** in front of the receiver (WAF).
- [ ] **IAM Recommender** review for over-broad worker SA roles
      (the default attaches `aiplatform.user` only — keep it lean).

## 13. Upgrade procedure

Cloud Run is revision-based: new traffic flows to the fresh
revision; in-flight requests on old revisions complete. The
example README § 13 has the exact `docker push` + `terraform apply`
sequence.

For blue/green: split traffic between two revisions via
`google_cloud_run_v2_service`'s `traffic` block; out of scope for
this minimal example.

## 14. Cleanup / teardown

`terraform destroy`, plus manual residue listed in the example
README § 14.

## 15. Troubleshooting

The example README § 15 has a top-10 errors table. Additional
patterns specific to this narrative:

- **Pub/Sub push delivery 401** — the OIDC audience must match the
  worker's URL. The module wires this, but if you change the worker
  service name post-deploy the audience drifts; re-run apply.
- **Cloud SQL "FATAL: no pg_hba.conf entry"** — when IAM auth is
  enabled but the application user is configured with a password,
  the `cloudsql.iam_authentication` flag's interaction with the
  legacy password user can confuse Postgres. The module sets the
  password explicitly; if you flip to IAM-only later, also drop the
  password role.
- **CodeCommit option** — N/A on GCP. CodeCommit is AWS-only;
  there's no GCP equivalent. For GCP-hosted git, use
  Cloud Source Repositories with the same GitHub adapter (the URL
  pattern matches).

## 16. References

- Spec §15.3 — GCP Cloud Run + Pub/Sub reference deploy.
- Spec §18.3 — per-cloud README outline (drives this doc's structure).
- [Cloud Run + Pub/Sub push](https://cloud.google.com/run/docs/triggering/pubsub-push)
- [Vertex AI Anthropic](https://docs.anthropic.com/en/api/claude-on-vertex-ai)
- [Cloud SQL Auth Proxy](https://cloud.google.com/sql/docs/postgres/connect-auth-proxy)
- [Binary Authorization for Cloud Run](https://cloud.google.com/binary-authorization/docs/setting-up-cloud-run)
