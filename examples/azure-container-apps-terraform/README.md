# Azure Container Apps + Terraform — review-agent reference deployment

Receiver Container App + worker Container App (KEDA-scaled on Service
Bus) + Service Bus + Postgres Flexible Server + Key Vault + Log
Analytics. Azure OpenAI by default for the LLM provider.

For the narrative version, see
[`docs/deployment/azure.md`](../../docs/deployment/azure.md). This
README is the operator-facing companion.

---

## 1. At a glance

- **Services**: Container Apps × 2, Service Bus Standard namespace +
  queue with DLQ, Postgres Flexible Server (Postgres 16), Key Vault
  (RBAC mode), User-Assigned Managed Identity, Log Analytics, ACR
  (you supply), Azure OpenAI (default LLM).
- **Monthly cost (eastus, 2026 list prices)**:
  - **Low** (~50 PRs/mo): ~$50/mo (Postgres `B_Standard_B1ms` $20
    + Container Apps consumption tier ~$15 + Azure OpenAI ~$10 +
    Service Bus + Key Vault negligible).
  - **Typical** (200 PRs/mo): ~$120/mo.
  - **High** (1,000 PRs/mo, `GP_Standard_D2s_v3`): ~$350/mo.
- **SLA**: Container Apps + Service Bus + Postgres Flexible Server
  all carry ≥ 99.9% Microsoft SLAs.
- **Scale**: solo team to mid-sized org. Container App KEDA scaling
  on Service Bus depth handles bursty traffic without per-PR
  cold-start overhead.

## 2. Architecture diagram

```
GitHub webhook
     │ HTTPS
     ▼
┌──────────────────────────┐
│ Container App: receiver   │
│  - HMAC verify §7.1       │
│  - idempotency check      │
│  - Send to Service Bus    │
└──────────┬────────────────┘
           ▼
┌──────────────────────────┐         ┌──────────────────────┐
│ Service Bus queue        │ ──────► │ DLQ (alarm > 0)      │
│ review-agent-jobs        │         │ (auto-managed)       │
└──────────┬───────────────┘         └──────────────────────┘
           ▼ (KEDA pulls + invokes)
┌──────────────────────────┐
│ Container App: worker     │──► Azure OpenAI
│ - clone (sparse)          │     (or external Anthropic)
│ - runner + middleware     │──► GitHub API
│ - post comments           │──► Postgres Flexible Server
│ - upsert review_state     │     (private, AAD-auth enabled)
└──────────┬────────────────┘
           │
           ▼
┌──────────────────────────┐
│ Key Vault (RBAC mode)    │  ◄── webhook secret
│ - github-app-pem         │      App PEM
│ - anthropic-api-key      │      (only when llm_provider="anthropic")
│ - <name>-database-url    │
└──────────────────────────┘
```

## 3. Prerequisites

- Azure CLI ≥ 2.62, Terraform ≥ 1.6, Docker.
- An Azure subscription with the resource providers registered:
  `Microsoft.App`, `Microsoft.ServiceBus`, `Microsoft.DBforPostgreSQL`,
  `Microsoft.KeyVault`, `Microsoft.OperationalInsights`,
  `Microsoft.ManagedIdentity`. (Most are auto-registered on first
  use; `az provider register` if you hit a 403.)
- A GitHub App (same setup as the AWS / GCP examples).
- **Azure OpenAI** resource provisioned out-of-band (regional
  capacity is gated). Create the resource, deploy a model (e.g.
  `gpt-4o`), and note the deployment name. The Terraform module
  consumes the resource endpoint + deployment name as inputs but
  does not create the Azure OpenAI resource itself — Microsoft
  recommends managing those via a separate, longer-lived workflow.
- An Azure Container Registry (or GHCR) holding the worker image.

## 4. Provider selection

Defaults to **Azure OpenAI** because:

- Auth = the worker's managed identity. No API key.
- Billing rolls into the same Azure subscription.
- Latency: same region as the Container App.
- Compliance: Azure OpenAI contractually keeps prompts /
  completions out of training pipelines.

Switch to `llm_provider = "anthropic"` (external API) when:

- Migrating from another cloud.
- Multi-cloud Anthropic governance is preferable.

In 2026, Anthropic-on-Azure (via Azure Marketplace) is in preview;
once GA, you can use the same `azure-openai` driver pointed at the
Marketplace endpoint — the protocol is OpenAI-shaped.

## 5. Step-by-step setup

| # | Action | Time |
|---|---|---|
| 1 | Create the GitHub App, download the PEM. | 10 min |
| 2 | Provision an Azure OpenAI resource + deploy a model. | 30 min (gated) |
| 3 | `terraform init && terraform apply -target=...db -target=...sb`. | 15 min |
| 4 | Build + push the worker image to ACR. | 10 min |
| 5 | `terraform apply` (creates Container Apps + Key Vault scaffolding). | 5 min |
| 6 | Populate Key Vault values (webhook + App PEM + optional Anthropic key). | 5 min |
| 7 | Paste the `webhook_url` output into the GitHub App. | 1 min |
| 8 | Open a draft PR; confirm the worker posts a review. | 5 min |

## 6. Terraform quickstart

```bash
cd examples/azure-container-apps-terraform
terraform init

cat > terraform.tfvars <<EOF
subscription_id          = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
location                 = "eastus"
github_app_id            = "1234567"
image_uri                = "<acr-name>.azurecr.io/review-agent:0.3.0"
db_password              = "$(openssl rand -base64 32)"
azure_openai_endpoint    = "https://my-aoai.openai.azure.com"
azure_openai_deployment  = "prod-large"
azure_openai_model       = "gpt-4o"
EOF

terraform plan
terraform apply
```

After apply, populate the Key Vault values that were created with
placeholder text:

```bash
KV=$(terraform output -raw key_vault_uri)
RG=$(terraform output -raw resource_group_name 2>/dev/null || echo review-agent-rg)

az keyvault secret set --vault-name "${KV#https://}" \
  --name review-agent-github-webhook-secret \
  --value "$(openssl rand -hex 32)"

az keyvault secret set --vault-name "${KV#https://}" \
  --name review-agent-github-app-private-key \
  --file path/to/your-github-app.private-key.pem

# only when llm_provider = "anthropic":
# az keyvault secret set --vault-name ... --name review-agent-anthropic-api-key --value "$ANTHROPIC_API_KEY"
```

## 7. LLM provider setup (Azure OpenAI)

1. **Provision a resource**:
   ```bash
   az cognitiveservices account create \
     --name my-aoai \
     --resource-group review-agent-rg \
     --kind OpenAI --sku S0 \
     --location eastus
   ```
2. **Deploy a model** (e.g. `gpt-4o`):
   ```bash
   az cognitiveservices account deployment create \
     --name my-aoai --resource-group review-agent-rg \
     --deployment-name prod-large \
     --model-name gpt-4o --model-version 2024-08-06 \
     --model-format OpenAI \
     --sku-capacity 60 --sku-name Standard
   ```
3. Pass the resulting endpoint + deployment name into Terraform:
   - `azure_openai_endpoint = "https://my-aoai.openai.azure.com"`
   - `azure_openai_deployment = "prod-large"`
   - `azure_openai_model = "gpt-4o"`
4. The worker's managed identity gets `Cognitive Services OpenAI
   User` on the Azure OpenAI resource — wire this manually
   post-apply (the resource is out of scope for this Terraform):
   ```bash
   IDENTITY_PRINCIPAL_ID=$(az identity show \
     --name review-agent-identity --resource-group review-agent-rg \
     --query principalId -o tsv)

   az role assignment create \
     --assignee "$IDENTITY_PRINCIPAL_ID" \
     --role "Cognitive Services OpenAI User" \
     --scope "$(az cognitiveservices account show --name my-aoai --resource-group review-agent-rg --query id -o tsv)"
   ```

## 8. Networking

- Container Apps environment is in a managed VNet; the receiver has
  external ingress, the worker is internal-only (KEDA scaler reads
  Service Bus directly).
- Postgres is `public_network_access_enabled = false`; only the
  Container Apps managed identity can reach it via Private Endpoint
  (configure separately in your VNet) or via the Azure Database
  Postgres firewall rules. The simplest path: enable
  `--public-network-access Disabled` and rely on the same VNet
  through Private DNS.
- Key Vault is `public_network_access_enabled = false`. Same VNet
  + Private Endpoint applies.
- Egress: outbound to Azure OpenAI endpoint, GitHub API, OTel
  collector. Add an Azure Firewall + WAF in front of the receiver
  for production.

## 9. Cost control

- `db_sku_name = "B_Standard_B1ms"` for low-traffic; bump to
  `GP_Standard_D2s_v3` past ~50 PRs/day.
- Container App **min replicas = 0** for the worker (KEDA scales
  from zero). The receiver minReplicas = 1 to keep webhook latency
  low.
- Azure OpenAI deployment **TPM** capacity governs spend per
  deployment. Scale capacity down for dev environments.
- **Cost Management + Billing** alerts at the subscription scope
  catch budget overruns.

## 10. Logging & observability

- Both Container Apps stream stdout/stderr to the Log Analytics
  workspace this module provisions. Query via
  `ContainerAppConsoleLogs_CL`.
- OTel: `otel_traces_endpoint` + `otel_headers` work the same as
  the AWS / GCP examples. Set them to forward to Application
  Insights via the Azure Monitor OTLP exporter, or to Langfuse /
  Honeycomb.

## 11. Backup & DR

- **Postgres Flexible Server**: 14 days backup retention for
  `prod`, 7 days otherwise. Geo-redundant backups on for `prod`.
  Point-in-time restore via `az postgres flexible-server restore`.
- **Key Vault** soft-delete is on (30-day retention) and purge
  protection is on for `prod`. Deleted secrets are recoverable.
- **Service Bus** message lock duration + max delivery count are
  the in-flight retry knobs; DLQ retains failed messages.

**RPO / RTO**: 5 min RPO (Postgres continuous backups), 20 min RTO
(`terraform apply` + Postgres PITR + Key Vault soft-delete recover).

## 12. Security hardening checklist

- [ ] **Microsoft Defender for Cloud** enabled at subscription scope.
- [ ] **Azure Policy** enforcing geo-redundant backups + customer-
      managed-key encryption on Postgres + Key Vault.
- [ ] **Azure Front Door** in front of the receiver for WAF + bot
      mitigation.
- [ ] **Private Endpoints** on Postgres + Key Vault — VNet-only
      access.
- [ ] **Quarterly secret rotation** for webhook + App PEM.
- [ ] **Azure AD Conditional Access** on the operator account that
      runs `terraform apply`.

## 13. Upgrade procedure

```bash
az acr login --name <acr-name>
VERSION=0.3.1
docker build -t review-agent:$VERSION .
docker tag review-agent:$VERSION <acr-name>.azurecr.io/review-agent:$VERSION
docker push <acr-name>.azurecr.io/review-agent:$VERSION

sed -i.bak "s|image_uri.*|image_uri = \"<acr-name>.azurecr.io/review-agent:$VERSION\"|" terraform.tfvars
terraform apply
```

Container Apps revision-based rollout: new traffic flows to the
fresh revision; in-flight requests on old revisions complete.

## 14. Cleanup / teardown

```bash
terraform destroy
```

Manual residue:

- ACR images: `az acr repository delete --name <acr-name> --repository review-agent --yes`
- GitHub App webhook URL: clear or uninstall.
- Anthropic API key (if used): revoke in console.anthropic.com.
- **Key Vault soft-delete**: deleted vaults stay recoverable for 30
  days. Purge with `az keyvault purge --name <vault-name>`.

## 15. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `terraform apply` fails on `azurerm_key_vault` "Forbidden" | Caller principal not a Key Vault Administrator | The module wires `Key Vault Secrets Officer` for the deploy principal — confirm `az account show --query user.name -o tsv` is the same principal you used for `terraform apply`. |
| Worker scales but immediately fails on Postgres connect | Private endpoint not yet wired | The module disables public access; either provision a Private Endpoint to the Container Apps VNet, or temporarily enable a firewall allowlist. |
| Service Bus queue grows but worker never wakes | KEDA trigger metadata mismatch | The module wires the queue + namespace explicitly; double-check after a name change. |
| Receiver returns 401 on every webhook | Webhook secret placeholder still in Key Vault | Run the `az keyvault secret set` command in § 6. |
| Azure OpenAI `403 Forbidden` from worker | Managed identity missing role | Run the role-assignment command in § 7. |
| Cold start > 8s | Container image too large | Run `pnpm prune --prod` in the Dockerfile's runtime stage. |

## 16. References

- [`docs/deployment/azure.md`](../../docs/deployment/azure.md) — narrative form.
- Spec §15.4 — Azure Container Apps + Service Bus reference deploy.
- Spec §18.3 — per-cloud README outline.
- [Container Apps + KEDA](https://learn.microsoft.com/en-us/azure/container-apps/scale-app)
- [Azure OpenAI deployments](https://learn.microsoft.com/en-us/azure/ai-services/openai/how-to/create-resource)
- [Postgres Flexible Server private access](https://learn.microsoft.com/en-us/azure/postgresql/flexible-server/concepts-networking-private)
