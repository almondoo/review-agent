# OpenAI-compatible endpoints (Ollama / vLLM / OpenRouter / LM Studio / LiteLLM)

`provider.type: openai-compatible` accepts any HTTP endpoint that
speaks the OpenAI Chat Completions API. The driver hands the request
to `@ai-sdk/openai-compatible`, which negotiates structured-output
support per endpoint:

1. **JSON-schema mode** (preferred) — endpoints that advertise the
   OpenAI `response_format: json_schema` parameter. Best fidelity.
2. **Tool-calling fallback** — endpoints that support OpenAI tools
   but not JSON Schema mode. Slightly worse rejection of malformed
   model output.
3. **JSON-mode prompt** — last resort. The SDK adds `Respond with
   JSON only` to the system prompt and parses the response. Fragile
   on small models.

`review-agent` doesn't choose between these — the SDK does it
automatically based on the endpoint's reported capabilities. What
you can do is **pick a model that handles JSON output well**.

---

## Tested endpoints (2026-04)

| Endpoint | Recommended models | Notes |
|---|---|---|
| Ollama (`/v1/chat/completions`) | `llama3.1:70b`, `qwen2.5:32b` | JSON-mode prompt only; the 7B–13B models drop fields half the time. Prefer ≥30B. |
| vLLM | any HF model with a chat template | JSON-schema mode works for instruction-tuned models that emit valid JSON; verify on your fixture before relying on it in CI. |
| OpenRouter | `anthropic/claude-sonnet-4-6`, `openai/gpt-4o` | Identical to direct providers; OpenRouter passes through structured output. Fee ≈ +5% over direct. |
| LM Studio | depends on the model loaded | Same caveats as Ollama. |
| LiteLLM proxy | depends on the upstream provider | Acts as a thin proxy — structured output works iff the upstream supports it. |

## Configuration

```yaml
# .review-agent.yml
provider:
  type: openai-compatible
  model: llama3.1:70b                          # whatever the endpoint accepts
  base_url: http://ollama.internal:11434/v1
  # API key is optional. Many local endpoints accept any non-empty
  # string; setting one stops the SDK from emitting a warning.
```

```bash
# env
export OPENAI_API_KEY=ollama-local-token
```

The driver reads `config.apiKey` first, then `OPENAI_API_KEY`, then
defaults to an empty string. If your endpoint genuinely needs no
auth, leave the env unset.

## Cost cap

`OPENAI_COMPATIBLE_PRICING` is empty by default — `priceForModel`
returns zero for every unknown model on this provider. That means:

- **Cost cap:** the per-PR `cost.max_usd_per_pr` and daily cap
  effectively become unbounded for these endpoints. The decision is
  intentional — local endpoints have no per-token bill, and
  aggregator pricing varies enough that we won't pretend to know
  what you'll actually pay.
- **If you want budget enforcement** for a paid OpenAI-compatible
  endpoint (OpenRouter, LiteLLM with a paid backend), add an entry
  to your wiring that overrides the pricing table at runtime:

  ```ts
  import { createOpenAICompatibleProvider, OPENAI_COMPATIBLE_PRICING } from '@review-agent/llm';
  // ... but instead of using OPENAI_COMPATIBLE_PRICING directly,
  // pass a customised pricing table by composing your own driver
  // from createGenericProvider + your own pricing dict.
  ```

  We don't surface this as a top-level config knob in v0.3 because
  the table format has not stabilised. Track it in the v0.4 issue
  list.

## Failure modes

| Symptom | Cause | Workaround |
|---|---|---|
| "Failed to parse model output as JSON" | Model emitted prose or code-fenced JSON. | Switch to a larger model; reduce diff size; add `temperature: 0` via your endpoint's defaults. |
| 404 `/v1/models` on bring-up | Endpoint doesn't expose the OpenAI models endpoint. | Set the model id explicitly in `.review-agent.yml`; the driver does not auto-discover. |
| 401 from a no-auth endpoint | The endpoint silently rejects the empty `Authorization` header. | Set `apiKey: 'any-non-empty-value'` in config. |
| Truncated output (review summary cuts off) | Endpoint's `max_tokens` default is too low. | Pass `--max-tokens` via your endpoint's runtime flags; the driver does not currently expose this. |
| Model returns valid JSON but with extra fields | The schema is strict (zod `.strict()`). The SDK rejects. | Use a model that respects schemas precisely; avoid mid-tier instruction-tuned generic chat models. |

## Why we ship this driver at all

Three reasons:

1. **Privacy-first deployments** that can't send code to a third
   party but can run a local 30B–70B model on a GPU box.
2. **Aggregator preference** — OpenRouter / LiteLLM let an
   organisation pick the best model per workload while keeping a
   single billing relationship.
3. **Eval against open-weights** — we want to validate our
   prompt-injection defenses against a model the team can re-run
   themselves, not just rely on closed-API providers.

## What it does NOT do

- It does not auto-discover available models. Set `model:` explicitly.
- It does not infer rate-limit headers (most local endpoints don't
  emit them). The retry middleware backs off on 429 only when the
  endpoint returns a 429; otherwise classifies as `transient`.
- It does not enforce structured output strength. If your endpoint
  emits malformed JSON, you'll see a `SchemaValidationError` from
  `@review-agent/core` — that's the correct loud failure mode; do
  not silently retry past the configured budget.
