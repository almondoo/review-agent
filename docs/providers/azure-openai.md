# Azure OpenAI provider setup

`provider.type: azure-openai` uses the Azure OpenAI Service via
`@ai-sdk/azure`. It is identical in model capability to the direct OpenAI API
but runs within your Azure subscription — useful for data residency, private
networking, and enterprise compliance requirements.

---

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `AZURE_OPENAI_API_KEY` | Yes | API key from the Azure OpenAI resource. |

The resource endpoint and deployment name are **not** read from env vars —
they must be set in `.review-agent.yml` (or via `config.baseUrl` /
`config.azureDeployment` in the programmatic API). This is intentional:
an Azure OpenAI resource endpoint encodes the deployment scope, and
environment-variable overrides would make the deployment name ambiguous.

---

## Getting credentials

1. In the [Azure Portal](https://portal.azure.com), navigate to your
   **Azure OpenAI** resource.
2. Under **Resource Management → Keys and Endpoint**, copy:
   - **Key 1** (or Key 2) → this is your `AZURE_OPENAI_API_KEY`
   - **Endpoint** → this is your `base_url` (e.g.
     `https://my-resource.openai.azure.com`)
3. Under **Model deployments → Manage Deployments** (Azure OpenAI Studio),
   note the **Deployment name** → this is your `azure_deployment`.

---

## Configuration

```yaml
# .review-agent.yml
provider:
  type: azure-openai
  model: gpt-4o                                    # the underlying OpenAI model id (for pricing)
  azure_deployment: my-gpt4o-deployment            # your Azure deployment name
  base_url: https://my-resource.openai.azure.com   # your Azure resource endpoint
  fallback_models:
    - gpt-4o-mini                                  # optional; deployment must also exist
```

### Key field semantics

- `model` — the underlying OpenAI model ID (e.g. `gpt-4o`). Used for
  pricing lookups only; does **not** determine the request target on Azure.
- `azure_deployment` — the deployment name you chose in Azure OpenAI Studio.
  This is what the API call targets.
- `base_url` — the resource endpoint URL (e.g.
  `https://<resource-name>.openai.azure.com`). Required; no default.

Both `azure_deployment` and `base_url` are required. The driver raises a
clear error at startup if either is missing.

---

## Pricing

Azure OpenAI prices match OpenAI's per-million-token rates for the same
underlying model. `packages/llm/src/pricing.ts` (`AZURE_OPENAI_PRICING`)
mirrors `OPENAI_PRICING`. Verify against the
[Azure pricing calculator](https://azure.microsoft.com/en-us/pricing/details/cognitive-services/openai-service/)
for your region.

---

## Prompt caching

Azure OpenAI does not expose a prompt-caching feature compatible with
review-agent's abstraction. `provider.anthropic_cache_control` is ignored.

---

## Caveats

- **Deployment name vs model name**: Azure lets you name deployments
  arbitrarily (e.g. a deployment called `prod-large` running `gpt-4o`). The
  `azure_deployment` field must match the deployment name, not the model name.
  The `model` field must match the underlying OpenAI model name for correct
  pricing.
- **API version**: the `@ai-sdk/azure` adapter handles API version selection
  internally. If you need to pin to a specific Azure OpenAI API version,
  open an issue — this is not currently exposed as a config option.
- **Private endpoint / VNet**: if your Azure OpenAI resource is behind a
  private endpoint, ensure the review-agent container's network can reach it.
  For the docker-compose stack, this typically means VNet peering or a VPN.
- **Data residency**: Azure OpenAI data does not leave your Azure region by
  default. Microsoft does not use customer data for model training. Abuse
  monitoring logs are retained for 30 days unless opted out via your EA.

---

## See also

- [parity-matrix.md](./parity-matrix.md) — cross-provider comparison.
- [azure.md](../deployment/azure.md) — full Azure deployment guide (Container
  Apps + Service Bus + Azure Database for PostgreSQL).
- [config-reference.md — `provider`](../configuration/config-reference.md#provider).
