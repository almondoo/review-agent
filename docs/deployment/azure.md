# Deploying review-agent on Azure (Container Apps + Service Bus + Postgres)

Container App receiver + Container App worker (KEDA-scaled on
Service Bus depth) + Service Bus queue + DLQ + Postgres Flexible
Server + Key Vault + Log Analytics. Azure OpenAI by default for
the LLM provider.

This is the long-form companion to
[`examples/azure-container-apps-terraform/`](../../examples/azure-container-apps-terraform/).
The 16-section breakdown below maps 1:1 to the §18.3 outline. The
operational steps + Terraform input reference live in the example
README; this doc covers the *why* + the Azure-specific bits.

Spec references: §15.4, §15.6.6, §18.3, §8.5, §17.1.

---

## 1. At a glance

- **Compute**: 2× Container App. Receiver scales 1–10; worker
  scales 0–20 via KEDA on Service Bus queue depth.
- **Queue**: Service Bus Standard namespace + queue with built-in
  DLQ, max delivery 5, lock duration 5 min.
- **Database**: Postgres Flexible Server 16 with AAD authentication
  enabled, public access disabled.
- **LLM provider**: Azure OpenAI by default — same managed-identity
  auth model as Bedrock on AWS / Vertex on GCP. External Anthropic
  also wired.
- **Webhook URL**: Container App ingress FQDN (or a Front Door
  custom domain).
- **Cost**: ~$50–$350/mo depending on PR volume; see the example
  README § 1.
- **Suitable for**: small team to mid-sized org. Per spec §15.4
  rationale, Container Apps is more reliable than Functions on
  Linux Consumption Plan for sustained Node.js workloads in 2026.

## 2. Architecture

GitHub posts to the receiver Container App's external ingress. The
receiver verifies the signature, idempotency-checks the delivery,
and sends a `JobMessage` to the Service Bus queue. KEDA's
Service-Bus scaler watches queue depth and scales the worker
Container App from 0 to up to 20 replicas. The worker consumes,
runs the review, and posts comments back. Postgres holds the
review state, cost ledger, audit log, and BYOK envelope blobs.
Key Vault holds the operator-managed secrets, accessed through the
shared user-assigned managed identity.

The same container image runs both Container Apps; the
`command` array selects the entrypoint. This keeps ACR storage low
and the rollout story uniform.

## 3. Prerequisites

- Azure CLI ≥ 2.62, Terraform ≥ 1.6, Docker.
- An Azure subscription with the relevant resource providers
  registered.
- A GitHub App created in your org (same setup as the AWS / GCP
  deployments).
- **Azure OpenAI** resource provisioned out-of-band — capacity is
  gated, so this stays in your slower governance workflow rather
  than in the per-app Terraform.
- An Azure Container Registry (or GHCR) holding the worker image.

## 4. Provider selection

Default: **Azure OpenAI** (e.g., a `gpt-4o` deployment in your
existing Azure OpenAI resource). Reasons:

- Auth is the worker's managed identity. No API key to rotate or
  leak via env.
- Billing rolls into the same Azure subscription.
- Latency: same region as the worker.
- Compliance: Azure OpenAI contractually keeps prompts /
  completions outside training pipelines.

Switch to:

- `llm_provider = "anthropic"` (external API): familiar from
  AWS / multi-cloud setups.

When **Anthropic on Azure Marketplace** is GA, the same
`azure-openai` driver works pointed at the Marketplace endpoint —
the protocol is OpenAI-shaped. Track the rollout in your provider
runbook before flipping.

## 5. Step-by-step setup

See [`examples/azure-container-apps-terraform/README.md`](../../examples/azure-container-apps-terraform/README.md)
§ 5–7 for the eight-step bring-up checklist + the exact `az` and
`terraform` commands. The Azure-specific extra steps are:

1. Provision the Azure OpenAI resource + deploy a model
   (managed outside this Terraform; gated capacity).
2. Wire the worker managed identity to the
   `Cognitive Services OpenAI User` role on the Azure OpenAI
   resource.
3. Populate Key Vault values post-apply (the Terraform creates
   placeholder secrets so the apply can succeed before the real
   values exist; replace via `az keyvault secret set`).

## 6. Terraform inputs reference

See `examples/azure-container-apps-terraform/variables.tf` — every
input has an inline description + (for enums) `validation` blocks.

## 7. LLM provider setup

### 7.1 Azure OpenAI (default)

1. Create the Azure OpenAI resource (one-time, governance workflow).
2. Deploy a model (`gpt-4o` recommended for v0.3).
3. Pass endpoint + deployment name to Terraform via
   `azure_openai_endpoint` + `azure_openai_deployment`.
4. Assign the `Cognitive Services OpenAI User` role on the resource
   to the user-assigned managed identity Terraform creates. (Manual
   step — the resource is out of scope for the Terraform module.)

### 7.2 External Anthropic

`llm_provider = "anthropic"` + populate `anthropic-api-key` in Key
Vault. The worker reads the secret name from
`ANTHROPIC_API_KEY_SECRET_NAME` env and pulls via the managed
identity.

**Recommended onboarding**: run `review-agent setup workspace` (CLI)
before populating the Key Vault secret. The command prints a manual
checklist (workspace creation, ZDR enable, spend cap), or with
`--api` calls the Anthropic Admin API directly (requires
`ANTHROPIC_ADMIN_KEY`, distinct from the inference key).

### 7.3 OpenAI-compatible endpoints

Not wired in this Terraform. Adapt by setting `LLM_PROVIDER=openai-compatible`
+ `OPENAI_BASE_URL` env vars on the worker Container App. See
`docs/providers/openai-compatible.md`.

## 8. Networking

- The receiver Container App has external ingress on port 8080.
  Front it with Azure Front Door (premium tier) for WAF + global
  load balancing if you need it.
- The worker Container App has no ingress — KEDA invokes
  internally via the Service Bus connection.
- **Postgres Flexible Server**: `public_network_access_enabled = false`.
  Production wiring uses Private Endpoints inside the Container
  Apps VNet.
- **Key Vault**: same — `public_network_access_enabled = false`,
  Private Endpoint inside the VNet.
- **Egress**: Azure OpenAI traffic stays inside Microsoft's
  backbone. GitHub API + OTel collector go via the Container Apps
  managed VNet's outbound.

## 9. Cost control

| Lever | Where | Effect |
|---|---|---|
| `db_sku_name = "B_Standard_B1ms"` | tfvars | Tiny dev tier; bump for prod. |
| `worker_max_replicas` | tfvars | Cap concurrent reviews → cap concurrent token spend. |
| Container App **minReplicas=0** | always-on | Idle = free. |
| Azure OpenAI **TPM capacity** | resource property | Caps total throughput on the deployment. |
| Subscription budget alert | Cost Management + Billing | Daily / monthly thresholds. |

The cost-ledger queries from `docs/cost/index.md` work identically
on Postgres Flexible Server.

## 10. Logging & observability

- Container Apps stream stdout/stderr to the Log Analytics
  workspace Terraform provisions. Query via
  `ContainerAppConsoleLogs_CL` (or `ContainerAppSystemLogs_CL`).
- Application Insights (OTel via Azure Monitor exporter) is the
  Azure-native trace backend. Set
  `otel_traces_endpoint = "https://<ai-region>.in.applicationinsights.azure.com/v2.1/track"`
  + the matching `otel_headers`.
- Body redaction stays on by default (`langfuse_log_bodies = "0"`).

## 11. Backup & DR

- **Postgres Flexible Server**: 14-day backup retention for `prod`
  (7 otherwise). Geo-redundant backups for `prod`. Point-in-time
  restore via `az postgres flexible-server restore`.
- **Service Bus** lock + max-delivery handle in-flight retries;
  DLQ holds 14 days of failed messages.
- **Key Vault** soft-delete (30 days) + purge protection (in
  `prod`) protect against accidental deletion.

**RPO / RTO**: 5 min RPO (Postgres continuous backups), 20 min RTO
(`terraform apply` + Postgres PITR + Key Vault soft-delete
recover).

## 12. Security hardening checklist

- [ ] **Microsoft Defender for Cloud** at subscription scope.
- [ ] **Azure Policy** enforcing geo-redundant backups + CMK
      encryption on Postgres + Key Vault.
- [ ] **Azure Front Door** + WAF in front of the receiver.
- [ ] **Private Endpoints** for Postgres + Key Vault.
- [ ] **Quarterly secret rotation**.
- [ ] **Azure AD Conditional Access** on the deploy principal.

## 13. Upgrade procedure

The example README § 13 has the exact
`docker push` + `terraform apply` sequence. Container Apps
revision-based rollout means new traffic moves over without
downtime; in-flight requests on old revisions complete.

For blue/green: Container Apps' `traffic_weight` block supports
percentage-based splits between revisions. Wire that in via a
separate apply once a new revision is healthy.

## 14. Cleanup / teardown

`terraform destroy`, plus manual residue listed in the example
README § 14.

## 15. Troubleshooting

The example README § 15 has the full top-10 errors table.
Additional Azure-specific patterns:

- **`azurerm` provider auth fails** — `az login` first; the module
  uses the default Azure CLI principal. For CI, use a service
  principal with `subscription_id` + `tenant_id` + `client_id` +
  `client_secret` env vars.
- **Container Apps `RegistrationState: NotRegistered`** —
  `az provider register --namespace Microsoft.App`. Some
  subscriptions need explicit registration before first use.
- **CodeCommit option** — N/A on Azure. CodeCommit is AWS-only.
  For Azure-hosted git, use Azure DevOps Repos with the same
  GitHub adapter (the URL pattern matches via personal access
  tokens).

## 16. References

- Spec §15.4 — Azure Container Apps + Service Bus reference deploy.
- Spec §18.3 — per-cloud README outline (drives this doc's
  structure).
- [Container Apps + KEDA scale rules](https://learn.microsoft.com/en-us/azure/container-apps/scale-app)
- [Azure OpenAI deployments](https://learn.microsoft.com/en-us/azure/ai-services/openai/how-to/create-resource)
- [Postgres Flexible Server private access](https://learn.microsoft.com/en-us/azure/postgresql/flexible-server/concepts-networking-private)
- [Application Insights OTel exporter](https://learn.microsoft.com/en-us/azure/azure-monitor/app/opentelemetry-overview)
