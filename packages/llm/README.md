# @review-agent/llm

Provider-agnostic LLM abstraction for the `review-agent` monorepo. Wraps the
Vercel AI SDK (`ai` ^4.x) with provider drivers — Anthropic ships in v0.1;
OpenAI / Azure OpenAI / Google / Vertex / Bedrock / OpenAI-compatible follow
in v0.2 and v0.3.

## Exports

- `LlmProvider` interface, `ProviderType`, `ProviderConfig` — core types per spec §5.2
- `ReviewInput`, `ReviewOutput` — runner ↔ provider contract
- `PROVIDER_DEFAULTS` — per-provider default + fallback model lists per spec §2.1
- `createAnthropicProvider(config)` — Anthropic driver via `@ai-sdk/anthropic`
- `withRetry(driver, fn)` — shared retry wrapper per spec §11.1
- `RetryError`, `errorClassification` types

## License

Apache-2.0
