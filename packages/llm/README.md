# @review-agent/llm

Provider-agnostic LLM abstraction for the `review-agent` monorepo. Wraps the
Vercel AI SDK (`ai` ^4.x) with provider drivers — Anthropic + OpenAI ship in
v0.1 / v0.2; Azure OpenAI / Google / Vertex / Bedrock / OpenAI-compatible
follow in v0.3 (#31).

## Exports

- `LlmProvider` interface, `ProviderType`, `ProviderConfig` — core types per spec §5.2
- `ReviewInput`, `ReviewOutput` — runner ↔ provider contract
- `PROVIDER_DEFAULTS` — per-provider default + fallback model lists per spec §2.1
- `createAnthropicProvider(config)` — Anthropic driver via `@ai-sdk/anthropic`
- `createOpenAIProvider(config)` — OpenAI driver via `@ai-sdk/openai`. Tokenizer
  uses `js-tiktoken` (`cl100k_base`) for `estimateCost`; falls back to a
  4-char-per-token approximation if init fails. No prompt caching (per spec
  §2.1 feature parity matrix)
- `classifyAnthropicError` / `classifyOpenAIError` — per-provider error
  semantics per spec §11.1 (429 → `rate_limit` w/ retry-after, 500/503 →
  `overloaded`, `context_length_exceeded` → `context_length`, 401/403 →
  `auth`, network → `transient`)
- `withRetry(driver, fn)` — shared retry wrapper per spec §11.1
- `ANTHROPIC_PRICING` / `OPENAI_PRICING` / `priceForModel` — per-model
  $/MTok lookup; OpenAI prices update frequently — keep this table in sync
  with https://openai.com/api/pricing/

## License

Apache-2.0
