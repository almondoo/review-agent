# Vertex AI provider setup

`provider.type: vertex` uses Google Cloud Vertex AI, which hosts both Anthropic
Claude and Google Gemini models behind GCP's data governance. Auth is via
**Application Default Credentials (ADC)** — no API key needed when running on
GCP (e.g. Cloud Run, GKE with Workload Identity).

Use this provider instead of [google.md](./google.md) when:
- You need GCP-level data residency guarantees.
- You are running on GCP and want keyless auth via Workload Identity.
- You want Claude models (Anthropic on Vertex) without a direct Anthropic API
  key.

---

## Credentials

Vertex AI uses **Application Default Credentials**, not an API key env var.
The driver never reads `ANTHROPIC_API_KEY` or `GOOGLE_GENERATIVE_AI_API_KEY`.

| Credential source | When it applies |
|---|---|
| `GOOGLE_APPLICATION_CREDENTIALS` env var | Path to a service-account JSON key file |
| Workload Identity Federation | Running on GKE / Cloud Run / Compute Engine with a bound service account |
| `gcloud auth application-default login` | Local development on a machine with `gcloud` |

In production (GKE / Cloud Run), the recommended approach is Workload Identity
Federation — no key files to manage.

### Required IAM role

The service account (or Workload Identity) needs:
- `roles/aiplatform.user` on the GCP project.

For Anthropic-on-Vertex specifically, you must also accept the Anthropic model
terms in the Vertex Model Garden before your first request.

---

## Configuration

```yaml
# .review-agent.yml
provider:
  type: vertex
  model: claude-sonnet-4-6@anthropic   # Anthropic Claude on Vertex
  vertex_project_id: my-gcp-project    # required
  region: us-central1                  # optional; defaults to us-central1
```

Or for Gemini on Vertex:

```yaml
provider:
  type: vertex
  model: gemini-2.0-pro
  vertex_project_id: my-gcp-project
  region: us-central1
```

### Region

The `region` field sets the Vertex AI endpoint region. It falls back to the
`CLOUD_ML_REGION` environment variable, then defaults to `us-central1`.

```yaml
provider:
  region: europe-west4    # for EU data residency
```

Check [cloud.google.com/vertex-ai/docs/general/locations](https://cloud.google.com/vertex-ai/docs/general/locations)
for the list of available regions per model.

### Supported models

**Anthropic Claude on Vertex:**

| Model ID | Input $/MTok | Output $/MTok | Prompt caching |
|---|---|---|---|
| `claude-sonnet-4-6@anthropic` | $3.00 | $15.00 | Yes |

**Gemini on Vertex** (same models as Google AI Studio):

| Model ID | Input $/MTok | Output $/MTok | Prompt caching |
|---|---|---|---|
| `gemini-2.0-pro` | $1.25 | $5.00 | No |
| `gemini-2.0-flash` | $0.075 | $0.30 | No |

Prices from `packages/llm/src/pricing.ts`. Verify at
[cloud.google.com/vertex-ai/pricing](https://cloud.google.com/vertex-ai/pricing).

---

## Prompt caching

Anthropic Claude models on Vertex support prompt caching (same as direct
Anthropic API). Set `anthropic_cache_control: true` (the default) to enable.
Gemini models on Vertex do not expose compatible caching.

---

## Caveats

- **`vertex_project_id` is required.** The driver raises a clear error at
  startup if this field is missing. There is no default.
- **Model ID format for Anthropic**: Vertex uses the `@anthropic` suffix
  (e.g. `claude-sonnet-4-6@anthropic`). Using the bare Anthropic model ID
  (`claude-sonnet-4-6`) will fail on Vertex — the suffix is required.
- **Terms acceptance**: Anthropic models on Vertex must be accepted in the
  [Model Garden](https://cloud.google.com/vertex-ai/docs/generative-ai/learn/generative-ai-studio)
  before first use.
- **GCP customer data**: GCP does not use customer data submitted to Vertex AI
  for model training. Per-region storage applies.

---

## Local development

For local development without Workload Identity:

```bash
gcloud auth application-default login
export GOOGLE_CLOUD_PROJECT=my-gcp-project   # or set vertex_project_id in .review-agent.yml
```

---

## See also

- [google.md](./google.md) — Google AI Studio (API key, no GCP project needed).
- [parity-matrix.md](./parity-matrix.md) — cross-provider comparison.
- [gcp.md](../deployment/gcp.md) — full GCP deployment guide.
- [config-reference.md — `provider`](../configuration/config-reference.md#provider).
