# @review-agent/eval

Golden PR set + [`promptfoo`](https://www.promptfoo.dev/) configuration for
regression evaluation of `review-agent`.

## Layout

```
packages/eval/
  promptfooconfig.yaml       # promptfoo entry point
  prompts/
    review-system.md         # eval prompt template
  fixtures/golden/
    known-bug/<slug>/diff.txt + expected.json
    no-issue/<slug>/diff.txt + expected.json
    red-team/<slug>/diff.txt + expected.json
    large-diff/<slug>/diff.txt + expected.json   (planned)
    incremental/<slug>/...                        (planned)
```

Categories follow spec §14.4. The v0.1 seed ships one fixture per active
category. Target by v1.0: ~100 fixtures total.

## Running locally

```bash
pnpm --filter @review-agent/eval install
ANTHROPIC_API_KEY=sk-... pnpm --filter @review-agent/eval eval
```

## CI gating

`.github/workflows/eval.yml` runs `promptfoo eval` on PRs that touch
`packages/runner/`, `packages/core/`, or `packages/eval/`. Per spec §14.3 the
job blocks merge if precision drops > 5 % or noise rate increases > 10 %
versus the previous baseline. The v0.1 workflow runs the eval and uploads
results; gating thresholds wire up alongside the baseline store in v0.2.

## Baseline measurement

`baseline.json` ships with `current_pass_rates.pending_measurement: true`
until the operator records the first row per
[`../../docs/eval/baseline-measurement.md`](../../docs/eval/baseline-measurement.md).
Per-provider parity numbers feed
[`../../docs/providers/parity-matrix.md`](../../docs/providers/parity-matrix.md)
via `parity.json` + `pnpm matrix:write`.

## Review-category regression gate (#143)

The category gate scores the candidate reviewer's output against versioned
golden fixtures tagged by review category (`security`, `performance`, `style`,
`tests`, `correctness`). At least three fixtures exist per category.

### Fixture layout

```
fixtures/golden/category/
  manifest.json                     # versioned fixture index
  security/hardcoded-secret/
    diff.txt                        # PR diff presented to the agent
    expected.json                   # expected findings + must_contain_any patterns
  security/path-traversal/...
  performance/n-plus-one-query/...
  ...                               # 3 fixtures per category, 15 total
category-baseline.json              # per-category precision/recall baseline + thresholds
```

### Determinism requirement

The candidate-results file that feeds the gate **must** be produced with
`temperature=0` (or a fixed seed where the provider supports it). This keeps
gate results reproducible across CI executions. All promptfoo runs in this
package already set `temperature: 0` in the provider config.

### Running locally

```bash
# 1. Produce candidate-results.json with temperature=0 via your LLM runner.
#    Shape: { "results": [{ "fixtureId": "security/hardcoded-secret", "findings": [...] }] }

# 2. Run the gate (compares against category-baseline.json):
pnpm --filter @review-agent/eval eval:gate -- --results candidate-results.json

# Exit 0 = ok. Exit 1 = regression detected (drop > per-category threshold).
# When the baseline is all-null (first run) the gate is informational: exits 0.
```

### Baseline update workflow (deliberate opt-in)

Baseline promotion is **not automatic**. A human must explicitly run
`eval:baseline --apply` after reviewing the scores:

```bash
# 1. Produce candidate-results.json with temperature=0.
# 2. Dry-run to preview what will be written:
pnpm --filter @review-agent/eval eval:baseline -- \
  --results candidate-results.json \
  --model-id claude-sonnet-4-6 \
  --git-sha "$(git rev-parse HEAD)"

# 3. If scores look correct, apply:
pnpm --filter @review-agent/eval eval:baseline -- \
  --results candidate-results.json \
  --model-id claude-sonnet-4-6 \
  --git-sha "$(git rev-parse HEAD)" \
  --apply

# 4. Commit category-baseline.json in a separate PR with human sign-off.
```

`category-baseline.json` is committed to the repository so every measurement
is traceable in git history. The `history` array accumulates all past runs.

### Configuring thresholds

Per-category thresholds live in `category-baseline.json` under `thresholds.per_category`.
The default is ±5% (0.05) for both precision and recall; `style` and `tests`
carry a looser recall threshold of 10% (0.10) because those categories have
higher ground-truth ambiguity. Adjust by editing the JSON and committing — the
gate reads thresholds at runtime.

### CI integration

`.github/workflows/eval.yml` runs `pnpm --filter @review-agent/eval run test`
on every PR touching `packages/runner/`, `packages/core/`, or `packages/eval/`.
That test suite covers the category-gate scoring logic without a live LLM. When
a full candidate-results file is available (live LLM run with API key), pipe it
through `eval:gate` as a separate step (see `eval.yml` comments).

## License

Apache-2.0
