# Per-provider feature parity matrix

`review-agent` supports seven LLM provider drivers. They are not
identical: prompt caching is Anthropic / Bedrock / Vertex-only,
structured output strength varies, and per-PR cost / latency / data
retention posture differs by orders of magnitude. This page is the
operator-facing reference for picking a provider informed.

Spec reference: §22 #12 (the deferred design question is resolved
here for v1.0). Source data lives at
[`packages/eval/parity.json`](../../packages/eval/parity.json) and
the rendered table below is regenerated from it via
`pnpm --filter @review-agent/eval matrix:write`.

---

## How to read this matrix

- **Eval columns** (precision, FP rate, noise Δ) come from the
  60-fixture corpus described in `packages/eval/README.md`. The
  Anthropic baseline model (`claude-sonnet-4-6`) defines the noise
  floor; `noise Δ vs baseline` shows each other provider's deviation
  in proportional terms.
- **Cost / latency** are wall-clock measurements from a full eval
  run. Per-provider cost is the median across all 60 fixtures.
  p95 latency is total wall time including retries.
- **Data retention** summarises the provider's default posture for
  the inference key tier `review-agent` recommends in deployment
  docs. Operators on enterprise contracts should confirm against
  their own contract — these are not legal guarantees.
- A `—` value means "not yet measured". When the table is fully
  populated, no `—` should remain except in the openai-compatible
  row where features are necessarily endpoint-dependent.

Re-run cost: a full re-measurement across all paid providers is
$5–8 per regen. The cadence is per minor release, plus on every
provider major version bump. CI does **not** auto-regenerate this
table — measurements are operator-triggered to avoid burning the
budget on every PR.

---

<!-- BEGIN matrix -->
_Numbers measured: **not yet measured**. Baseline: `claude-sonnet-4-6`. See [packages/eval/parity.json](../../packages/eval/parity.json) for source data._

| Provider | Default model | Prompt caching | Structured output | Tool calling | Precision | FP rate | Noise Δ vs baseline | Median PR cost (USD) | p95 latency (s) | Data retention |
|---|---|---|---|---|---|---|---|---|---|---|
| Anthropic (direct) | `claude-sonnet-4-6` | yes | json-schema | yes | — | — | baseline | — | — | ZDR opt-in per Workspace; default 30-day retention |
| OpenAI (direct) | `gpt-4o` | no | json-schema | yes | — | — | — | — | — | ZDR opt-in for Enterprise tier; default 30-day retention |
| Azure OpenAI | `gpt-4o` | no | json-schema | yes | — | — | — | — | — | no training-data use by default; abuse-monitoring 30 days unless opt-out |
| Google (Gemini direct) | `gemini-2.0-pro` | no | json-schema | yes | — | — | — | — | — | paid tier: no training-data use; default retention varies |
| Vertex AI | `claude-sonnet-4-6@anthropic` | yes | json-schema | yes | — | — | — | — | — | GCP customer data not used for model training |
| AWS Bedrock | `anthropic.claude-sonnet-4-6-v1:0` | yes | json-schema | yes | — | — | — | — | — | AWS customer data not used for model training; per-region storage |
| OpenAI-compatible (Ollama / vLLM / OpenRouter / LM Studio) | `endpoint-dependent` | endpoint-dependent | endpoint-dependent | endpoint-dependent | — | — | — | — | — | endpoint-dependent (often local-only for self-hosted backends) |

Numbers measured via the 60-fixture corpus (packages/eval/fixtures/golden/). Re-run via `pnpm --filter @review-agent/eval matrix:run -- <provider>` (one provider at a time so cost is bounded). Estimated full re-measurement cost across all paid providers: $5-8 per regen run.
<!-- END matrix -->

---

## Caveats

- **Version pins**: each provider's model id is pinned in
  [`packages/llm/src/pricing.ts`](../../packages/llm/src/pricing.ts).
  When upstream deprecates a model (e.g. `gpt-4o` → `gpt-4.1`), the
  pinned default changes in a minor release and the matrix is
  regenerated. The "Default model" column reflects the **current**
  pinned default, not whichever model was current at last
  measurement.
- **OpenAI-compatible row**: there is no canonical model. Per
  [`./openai-compatible.md`](./openai-compatible.md), behaviour
  depends entirely on the endpoint — most local 30B–70B models clear
  the structured-output bar; smaller models do not. We do not
  publish per-endpoint numbers because the matrix would never stop
  growing.
- **Cost columns assume the workload shape from the 60-fixture
  corpus** — diffs ranging from a few-line bug fix up to a 3000-line
  large-diff fixture. Real-world median cost is usually lower
  because production diffs are smaller; large-diff outliers
  dominate the p95.
- **No regression CI for this table**. After updating
  `parity.json` the operator re-runs
  `pnpm --filter @review-agent/eval matrix:write` to refresh the
  rendered block; nothing automatically verifies that the
  `parity.json` numbers are still accurate. That responsibility
  lives with the operator running scheduled re-measurements per
  the cadence above.
- **Provider rows that fail the existing `baseline.json` gates**
  (precision < 0.9 / FP > 0.05 / red-team-bypass > 0) are
  documented here with rationale rather than silently relaxing the
  gate in `baseline.json`. If a provider can't clear the gate even
  after prompt tuning, the matrix gets a footnote explaining the
  trade-off (e.g. "openai-compatible/llama3.1:70b: precision 0.78,
  acceptable for self-hosted privacy-first use only").

---

## Regenerating the matrix

Operator workflow for a fresh measurement:

```bash
# 1. Run promptfoo against each provider with credentials in the env.
ANTHROPIC_API_KEY=...    pnpm --filter @review-agent/eval eval -- --providers anthropic:messages:claude-sonnet-4-6 -o results-anthropic.json
OPENAI_API_KEY=...       pnpm --filter @review-agent/eval eval -- --providers openai:gpt-4o                       -o results-openai.json
# (repeat for azure-openai / google / vertex / bedrock / openai-compatible)

# 2. Aggregate the per-provider precision / FP / latency numbers
#    into packages/eval/parity.json. (Manual step today; a future
#    matrix:aggregate subcommand could automate this.)

# 3. Refresh the published doc.
pnpm --filter @review-agent/eval matrix:write
```

`matrix:write` only mutates the block between
`<!-- BEGIN matrix -->` and `<!-- END matrix -->` — surrounding
prose is preserved. Edit the prose freely; it is never
auto-overwritten.

---

## Cross-references

- [`./openai-compatible.md`](./openai-compatible.md) — caveats on
  the openai-compatible row.
- [`packages/eval/baseline.json`](../../packages/eval/baseline.json) — gates the matrix
  cells must clear.
- [`packages/eval/parity.json`](../../packages/eval/parity.json) — source data for the
  rendered table above.
- [`packages/llm/src/pricing.ts`](../../packages/llm/src/pricing.ts) — pinned model ids
  per provider.
- [UPGRADING.md](../../UPGRADING.md) — model-default changes are
  minor bumps; this matrix is regenerated alongside.
