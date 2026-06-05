# OpenAI provider setup

`provider.type: openai` uses the OpenAI Chat Completions API via the
`@ai-sdk/openai` adapter.

---

## Environment variable

| Variable | Required | Description |
|---|---|---|
| `OPENAI_API_KEY` | Yes | API key from [platform.openai.com](https://platform.openai.com/api-keys). Starts with `sk-`. |

The driver reads `OPENAI_API_KEY` from the environment. Supply it as a
repository secret (GitHub Actions), a `.env` entry (docker-compose), or your
cloud secret store.

---

## Getting an API key

1. Sign in at [platform.openai.com](https://platform.openai.com).
2. Go to **API keys** → **Create new secret key**.
3. Copy the key immediately.
4. Set `OPENAI_API_KEY=<key>` in your deployment environment.

Ensure your OpenAI project has sufficient credits or a payment method. You
may want to set a **Usage limit** in the OpenAI billing dashboard to prevent
runaway spend independent of `cost.daily_cap_usd`.

---

## Configuration

```yaml
# .review-agent.yml
provider:
  type: openai
  model: gpt-4o              # recommended default
  fallback_models:
    - gpt-4o-mini            # cheaper fallback on rate-limit errors
```

### Supported models

| Model ID | Input $/MTok | Output $/MTok | Notes |
|---|---|---|---|
| `gpt-4o` | $2.50 | $10.00 | Recommended; strong structured output |
| `gpt-4o-mini` | $0.15 | $0.60 | Fast / cheap; good for draft reviews |
| `gpt-4.1` | $2.00 | $8.00 | Latest GPT-4.1 |
| `gpt-4.1-mini` | $0.40 | $1.60 | Efficient GPT-4.1 mini |

Prices are from `packages/llm/src/pricing.ts`. Verify against
[openai.com/api/pricing](https://openai.com/api/pricing) for current rates.

---

## Prompt caching

OpenAI does not expose a prompt-caching feature compatible with review-agent's
abstraction. The `provider.anthropic_cache_control` key is ignored when
`type: openai`. No cache-related cost adjustment is made.

---

## Token counting

The OpenAI driver uses `js-tiktoken` (`cl100k_base` encoding) for cost
estimation. If `js-tiktoken`'s WASM initialisation fails at runtime, the
driver falls back to a character-based approximation (chars / 4). The fallback
is noted in the run log.

---

## Rate limits and retry behaviour

The driver retries on HTTP 429, honouring both `retry-after-ms` and
`retry-after` (seconds) headers. HTTP 500 and 503 are classified as
`overloaded` and also retried.

OpenAI rate limits vary by tier and model. Check your **Usage** page in the
OpenAI dashboard for per-model TPM/RPM limits.

---

## Caveats

- **No prompt caching**: cached input tokens are not available on this
  provider; see parity matrix.
- **ZDR opt-in**: Zero Data Retention is available only on the Enterprise
  tier via `organization` settings. Default retention is 30 days. Verify
  with your OpenAI contract for the exact posture.
- **Structured output**: OpenAI supports `response_format: json_schema`
  on `gpt-4o` and newer models. The AI SDK selects this automatically.
  Older models (e.g. `gpt-3.5-turbo`) are not supported.

---

## See also

- [parity-matrix.md](./parity-matrix.md) — cross-provider comparison.
- [openai-compatible.md](./openai-compatible.md) — for Ollama, OpenRouter,
  LiteLLM and other OpenAI-API-compatible endpoints.
- [config-reference.md — `provider`](../configuration/config-reference.md#provider).
