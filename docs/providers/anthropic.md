# Anthropic provider setup

Anthropic's direct API (`provider.type: anthropic`) is the default provider
and the one all eval numbers are measured against. It is the recommended
starting point for any new deployment.

---

## Environment variable

| Variable | Required | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | Yes | API key from [console.anthropic.com](https://console.anthropic.com). Starts with `sk-ant-`. |

The driver reads `ANTHROPIC_API_KEY` from the environment. The key can also be
supplied via `config.apiKey` in the programmatic API, but for operator
deployments the env var is the standard path.

---

## Getting an API key

1. Sign in at [console.anthropic.com](https://console.anthropic.com).
2. Go to **API Keys** → **Create Key**.
3. Copy the key immediately — it is not shown again.
4. Set `ANTHROPIC_API_KEY=<key>` in your deployment environment (`.env`,
   GitHub Actions secret, AWS Secrets Manager, etc.).

---

## Configuration

```yaml
# .review-agent.yml
provider:
  type: anthropic
  model: claude-sonnet-4-6        # recommended default
  # optional:
  anthropic_cache_control: true   # enable prompt caching (default: true)
  fallback_models:
    - claude-sonnet-4-5           # tried on rate-limit / availability errors
```

### Supported models

| Model ID | Input $/MTok | Output $/MTok | Notes |
|---|---|---|---|
| `claude-sonnet-4-6` | $3.00 | $15.00 | Default; best precision/cost balance |
| `claude-sonnet-4-5` | $3.00 | $15.00 | Previous Sonnet generation |
| `claude-haiku-4-5-20251001` | $0.80 | $4.00 | Fast/cheap; lower precision — suitable for draft-only or cost-capped repos |

Prices are from `packages/llm/src/pricing.ts` as of this writing. Verify
against [anthropic.com/pricing](https://www.anthropic.com/pricing) for current
rates.

---

## Prompt caching

`provider.anthropic_cache_control: true` (the default) attaches
`cache_control: ephemeral` to the system prompt. Anthropic caches the
system prompt across calls within a 5-minute window, reducing input token
cost on subsequent steps of the same review.

Cache read cost: $0.30/MTok (vs $3.00/MTok for uncached input).
Cache write cost: $3.75/MTok (one-time, amortised across the window).

Disable if you're troubleshooting token accounting or if your system prompt
changes every step (caching provides no benefit in that case):

```yaml
provider:
  anthropic_cache_control: false
```

---

## Rate limits and retry behaviour

The runner retries on HTTP 429 (rate limit) and HTTP 529 (overloaded) with
exponential back-off. The `retry-after` header is honoured when present.

Typical Anthropic rate-limit tiers (verify on your Workspace plan):

| Tier | Requests/min | Input tokens/min |
|---|---|---|
| Free / Build | 50 | 40 000 |
| Scale / Production | per-contract | per-contract |

If you see persistent 429s, use `cost.daily_cap_usd` as a secondary guard
or add `fallback_models` to automatically fall back to a cheaper model.

---

## Caveats

- **Workspace ZDR**: Zero Data Retention (ZDR) is an opt-in Workspace setting
  on the Anthropic side. If your security policy requires ZDR, enable it in
  the Anthropic Console before using this provider. See the parity matrix for
  the default data retention posture.
- **No streaming**: the driver uses `generateText` (non-streaming) so that
  structured output (`experimental_output`) works reliably. This is an
  intentional trade-off.

---

## See also

- [parity-matrix.md](./parity-matrix.md) — cross-provider feature / eval /
  cost comparison.
- [`schema/v1.json`](../../schema/v1.json) — `provider` object schema.
- [config-reference.md — `provider`](../configuration/config-reference.md#provider)
  — full provider config reference.
