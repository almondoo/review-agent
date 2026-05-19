# LLM-as-a-Judge auto-grader

Issue [#101](https://github.com/almondoo/review-agent/issues/101) /
spec §11 (eval) / §14 (baseline gate).

The v1.2 eval (#90) ships a deterministic, structural pipeline:
- promptfoo runs the agent against 60 fixtures;
- the severity-consistency shim aggregates per-fixture stability;
- `baseline.json.current_pass_rates.severity_consistency_score`
  reflects whether the modal severity is stable enough.

That measures the **shape** of the output, not the **quality** of each
comment. The LLM-as-a-Judge runner closes that gap: a second LLM
(default: Anthropic Opus) reads each candidate comment and grades it
on four axes (Accuracy / Specificity / Actionability / Severity
calibration, 1–5 each). The aggregate score in [1, 5] lands in
`baseline.json.current_pass_rates.llm_judge_score` and in each
`parity.json` provider row's `eval.llm_judge_score`.

**Status: informational.** The first cut is intentionally NOT a CI
gate. Score variance and bias calibration need a few months of
runtime data before we promote the gate to enforcing. The
`--enforce-judge-gate` CLI flag is reserved for that promotion; today
the runner exits 0 regardless of score.

---

## Quick start

### 1. Run the candidate-output capture step

The judge consumes the same per-fixture results file the
severity-consistency gate consumes (`severity-consistency-input.json`
in `packages/eval/`). Build it first:

```bash
cd packages/eval
ANTHROPIC_API_KEY=sk-ant-... pnpm eval:severity-consistency
pnpm shim:severity-input -- \
  --in severity-consistency-results.json \
  --out severity-consistency-input.json
```

### 2. Run the judge

```bash
ANTHROPIC_API_KEY=sk-ant-... \
  pnpm --filter @review-agent/eval judge -- \
    --candidate-results packages/eval/severity-consistency-input.json \
    --judge-provider anthropic \
    --judge-model claude-opus-4-7
```

Defaults:

- `--judge-provider anthropic`
- `--judge-model claude-opus-4-7`
- `--prompt packages/eval/prompts/judge.md`
- raw artifacts under `packages/eval/.promptfoo/judge/<ts>.json`

Optional persistence flags:

- `--out <path>` — write the aggregate (score + per-axis means) to a
  side-car JSON for downstream tooling.
- `--baseline-apply` — write `llm_judge_score` +
  `llm_judge_metadata` into `packages/eval/baseline.json`. Mirrors
  the `baseline:measure --apply` convention from #97.
- `--parity-apply <provider-id>` — write `eval.llm_judge_score` into
  the named row in `packages/eval/parity.json` (one provider per
  invocation; run multiple times to populate the matrix).

### 3. Switch providers

Any provider supported by `@review-agent/llm`'s registry is allowed:
`anthropic`, `openai`, `azure-openai`, `google`, `vertex`, `bedrock`,
`openai-compatible`. The env vars match `createProvider` exactly
(e.g. `OPENAI_API_KEY` for OpenAI, AWS creds for Bedrock).

```bash
# Sanity-check by judging with OpenAI instead of Anthropic
OPENAI_API_KEY=sk-... \
  pnpm --filter @review-agent/eval judge -- \
    --candidate-results packages/eval/severity-consistency-input.json \
    --judge-provider openai --judge-model gpt-4o
```

---

## Cost estimate

A full run grades every comment emitted by the candidate model
(`severity-consistency-results.json` contains 3 runs × 6 fixtures = 18
short comment-arrays for the severity-consistency subset; ~60 for the
golden corpus). One judge call per (fixture, run), each round-trip
~1–2 K tokens in / ~0.5 K tokens out.

- **Anthropic Opus** (default judge): ~$15 / Mtok in, ~$75 / Mtok
  out. Estimated $1–$3 per full corpus run.
- **OpenAI GPT-4o** (cheaper alternative): ~$0.30–$1 per full run.
- **Anthropic Sonnet**: ~$0.20–$0.60 per full run, **but uses the
  same family as the candidate model** so bias risk is higher.

These numbers do NOT include the candidate-side promptfoo run that
produces the input. Per-PR CI cost: the judge is gated behind
`ANTHROPIC_API_KEY` and runs `continue-on-error: true`, so it does
not contribute to the per-PR critical-path cost cap.

---

## Scoring rubric (1–5 per axis, aggregate = simple mean rounded
to 1 decimal place)

| Axis | 1 | 3 | 5 |
|---|---|---|---|
| **Accuracy** (technical correctness) | wrong claim / fatal misunderstanding | mostly right, fuzzy details | fully correct |
| **Specificity** (concreteness) | generic platitude | points at the relevant area | explains the underlying mechanism |
| **Actionability** (fixability) | unclear what to do | direction is given | machine-applicable suggestion |
| **Severity calibration** (severity vs rubric) | wrong severity | off by one step | exact match |

The four axes are aggregated by simple mean (rounded to two decimal
places internally; baseline.json shows one decimal). A comment that
the judge could not parse is skipped (`scores: null`,
`skipped: true`) and excluded from the aggregate denominator. Skips
do NOT count as failures; they only shrink the sample.

---

## Schema validation + retry

The judge is instructed to emit strict JSON:

```json
{
  "comments": [
    {
      "id": "<string>",
      "scores": {
        "accuracy": 5,
        "specificity": 4,
        "actionability": 5,
        "severity_calibration": 5
      },
      "reasoning": "<one sentence>"
    }
  ]
}
```

Each axis is a Zod-validated integer in `[1, 5]`. On parse / schema
failure the runner retries the same call exactly once. If the second
attempt also fails, the affected comments are recorded with
`scores: null` and `skipped: true` so the aggregate is not skewed by
malformed responses. Raw attempts (both pass and fail) are persisted
in `packages/eval/.promptfoo/judge/<timestamp>.json` so CI artifact
review can diagnose drift.

---

## Why this is NOT a gate (yet)

1. **Bias risk.** The default judge (Opus) shares the Anthropic
   family with the default candidate (Sonnet 4.6). A within-family
   judge can systematically over- or under-rate phrasing styles. We
   want a few cross-provider runs in the parity sheet before trusting
   the absolute score.
2. **Score variance.** A 4-axis rubric averaged across a small
   corpus (60 fixtures) has high variance run-over-run. Setting a
   gate before measuring the noise floor would flap.
3. **Calibration data.** We have no human-labelled baseline yet. The
   correlation analysis between judge scores and reviewer feedback
   (👍 / 👎 from #92) is a separate follow-up issue.

Once the parity sheet has multiple judges × candidates and the
correlation matrix is healthy, a future PR can:

- pin a `gates.llm_judge_score_min` threshold;
- flip `--enforce-judge-gate` to non-zero exit code;
- promote the CI step from `continue-on-error: true` to a hard fail.

See issue [#101](https://github.com/almondoo/review-agent/issues/101)
"Out of scope" section for the items deliberately deferred.

---

## Files of interest

- `packages/eval/prompts/judge.md` — versioned judge prompt
  (YAML frontmatter `id: judge`, `version: 1`).
- `packages/eval/scripts/llm-as-judge.ts` — CLI + library.
- `packages/eval/scripts/__tests__/llm-as-judge.test.ts` — unit
  tests for the schema, retry path, aggregation, and provider switch.
- `packages/eval/baseline.json` — `current_pass_rates.llm_judge_score`
  field (nullable).
- `packages/eval/parity.json` — each provider row's
  `eval.llm_judge_score` field (nullable).
- `.github/workflows/eval.yml` — informational `Run LLM-as-a-Judge`
  step gated on `ANTHROPIC_API_KEY`.
- `docs/eval/baseline-measurement.md` — sibling page for the
  severity-consistency / golden baseline pipeline.
