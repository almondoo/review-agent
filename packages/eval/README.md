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

## License

Apache-2.0
