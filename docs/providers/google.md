# Google AI Studio (Gemini) provider setup

`provider.type: google` uses the Google AI Studio API (Gemini models accessed
via an API key). This is distinct from
[Vertex AI](./vertex.md), which hosts the same models on GCP and uses
Application Default Credentials instead of an API key.

Use this provider if you already have a Gemini API key and do not need
GCP-level data governance. For production multi-tenant deployments,
[Vertex AI](./vertex.md) is preferred.

---

## Environment variable

| Variable | Required | Description |
|---|---|---|
| `GOOGLE_GENERATIVE_AI_API_KEY` | Yes | API key from [aistudio.google.com](https://aistudio.google.com/app/apikey). |

---

## Getting an API key

1. Sign in at [aistudio.google.com](https://aistudio.google.com).
2. Click **Get API key** → **Create API key in new project** (or select an
   existing project).
3. Copy the key and set `GOOGLE_GENERATIVE_AI_API_KEY=<key>` in your
   deployment environment.

Free-tier keys have generous quotas for evaluation; for production use the
paid tier (enables higher RPM and removes the "no training data use" caveat).

---

## Configuration

```yaml
# .review-agent.yml
provider:
  type: google
  model: gemini-2.0-pro       # recommended default
  fallback_models:
    - gemini-2.0-flash        # cheaper fallback
```

### Supported models

| Model ID | Input $/MTok | Output $/MTok | Notes |
|---|---|---|---|
| `gemini-2.0-pro` | $1.25 | $5.00 | Recommended for review quality |
| `gemini-2.0-flash` | $0.075 | $0.30 | Fast/cheap; lower precision |

Prices are from `packages/llm/src/pricing.ts` at 2026-04 GA rates. Verify
against [ai.google.dev/pricing](https://ai.google.dev/pricing).

---

## Prompt caching

Google AI Studio does not expose a prompt-caching feature compatible with
review-agent's abstraction. `provider.anthropic_cache_control` is ignored.

---

## Rate limits and retry behaviour

The driver retries on HTTP 429 and 503. Google AI Studio's free tier has
conservative RPM limits; the paid tier limits are higher. Check the
[quota dashboard](https://console.cloud.google.com/iam-admin/quotas) for your
project.

---

## Caveats

- **Free tier data policy**: on the free (AI Studio) tier, Google may use
  request data to improve models. If your org's policy prohibits this, use
  the paid tier or switch to [Vertex AI](./vertex.md) (GCP customer data is
  never used for model training).
- **Structured output**: `gemini-2.0-pro` and `gemini-2.0-flash` support
  JSON schema mode. Older Gemini 1.x models are not supported by this driver.
- **No prompt caching**: see parity matrix.

---

## See also

- [vertex.md](./vertex.md) — Vertex AI: same Gemini models, GCP
  infrastructure, Application Default Credentials.
- [parity-matrix.md](./parity-matrix.md) — cross-provider comparison.
- [gcp.md](../deployment/gcp.md) — GCP deployment guide.
- [config-reference.md — `provider`](../configuration/config-reference.md#provider).
