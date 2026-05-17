# Recording the eval baseline

`packages/eval/baseline.json` is the source of truth for what
constitutes "passing" on the 60-fixture golden corpus. The
`gates.*` block holds the merge-blocking thresholds; the
`current_pass_rates.*` block records the most recent measured
performance on the default provider stack.

This page documents the **measurement procedure** for populating
`current_pass_rates` and the per-provider runs feeding the parity
matrix in [`../providers/parity-matrix.md`](../providers/parity-matrix.md).
Spec reference: PRD §12.1 v1.0, v1.0 issue #45.

The current state of `baseline.json` ships with `pending_measurement:
true` and all numeric fields `null` — the schema is in place but no
row has been measured yet. The first row is the operator's
responsibility, run from a workstation or a dedicated CI job, **not**
from the per-PR self-review CI (which would burn the budget on every
PR).

---

## When to re-measure

Trigger | Cadence
---|---
First v1.0 baseline | Once before the v1.0 tag.
Default provider model bump | Each time `packages/llm/src/pricing.ts` updates the pinned default (e.g. `claude-sonnet-4-6` → `claude-sonnet-4-7`).
Provider parity matrix refresh | Per minor release, plus on every provider major version bump.
Prompt rewrite touching `packages/runner/src/prompts/` | Any non-cosmetic change to the system prompt.
Suspected regression | Whenever a real PR shows an unexpected false-positive or miss.

Cost: ~$2.20 per Sonnet-4.6 run on the 60-fixture corpus
(`baseline.json.estimated_run_cost_usd`). Per-provider runs total
$5–8 per regen across the seven drivers.

---

## Procedure

### 1. Record the snapshot inputs

Capture the exact code revision being measured. The `git_sha` is
mandatory so a future regression bisect can rebuild the same
baseline.

```bash
cd /path/to/review-agent
GIT_SHA=$(git rev-parse HEAD)
DATE=$(date -u +%Y-%m-%d)
MODEL_ID=$(node -e "import('./packages/llm/dist/index.js').then(m => process.stdout.write(m.DEFAULT_ANTHROPIC_MODEL))" 2>/dev/null || echo "claude-sonnet-4-6")
echo "git_sha=$GIT_SHA  date=$DATE  model=$MODEL_ID"
```

### 2. Run the golden eval against the default provider

```bash
ANTHROPIC_API_KEY=sk-ant-... \
  pnpm --filter @review-agent/eval eval -- -o results-default.json
```

`results-default.json` contains per-fixture pass / fail rows. The
aggregation step (next) reduces them to the five `current_pass_rates`
fields.

### 3. Run the red-team eval (gate: `red_team_bypass_count` MUST be 0)

```bash
ANTHROPIC_API_KEY=sk-ant-... \
  pnpm --filter @review-agent/eval eval:red-team -- -o results-red-team.json
```

Any non-zero bypass count blocks the row from being recorded —
investigate the bypass and ship a prompt fix or a detector hardening
in the same PR.

### 4. Aggregate per-fixture results into the five baseline fields

The aggregation today is manual: open `results-default.json`, count
known-bug TP / FP / FN per the rules in §14.3 of the implementation
spec, divide. A `scripts/aggregate-baseline.ts` helper is a v1.x
nice-to-have but not blocking — the math is straightforward at 60
fixtures.

| Field | Formula |
|---|---|
| `known_bug_precision` | TP / (TP + FP), measured on `category: known-bug` fixtures only. |
| `known_bug_recall` | TP / (TP + FN), measured on `category: known-bug` fixtures. |
| `no_issue_false_positive_rate` | (count of fixtures with ≥ 1 comment) / (total `category: no-issue`). |
| `red_team_bypass_count` | from `results-red-team.json`; non-zero blocks merge. |
| `large_diff_max_wall_seconds` | max wall time across `category: large-diff` fixtures. |
| `multi_language_target_language_match_rate` | fraction of `category: multi-language` fixtures whose comments are in the configured target language. |

### 5. Update `current_pass_rates` and append to `history`

Open `packages/eval/baseline.json` and:

1. Move the previous `current_pass_rates` block (if non-null) into
   the `history: []` array as a new object — preserve the previous
   `measurement_metadata` block intact.
2. Replace `current_pass_rates` with the new measurement:

```json
"current_pass_rates": {
  "pending_measurement": false,
  "measurement_metadata": {
    "recorded_at": "2026-05-15",
    "model_id": "claude-sonnet-4-6",
    "git_sha": "abc1234",
    "notes": "First v1.0 baseline. Per-fixture aggregation via manual count."
  },
  "known_bug_precision": 0.94,
  "known_bug_recall": 0.78,
  "no_issue_false_positive_rate": 0.03,
  "red_team_bypass_count": 0,
  "large_diff_max_wall_seconds": 47,
  "multi_language_target_language_match_rate": 0.98
}
```

3. Confirm every field clears its `gates.*_min` / `_max` threshold.
   If a field falls below the gate (e.g. `precision = 0.85` against
   the `0.9` gate), there are two acceptable responses, **not** a
   silent gate relaxation:
   - **Tune the prompt and re-measure** — preferred when the
     regression looks fixable.
   - **Document the gate revision in the same PR** — acceptable
     only when a careful review confirms the gate was set
     unrealistically. The PR description must explain *why* the
     real-world quality is preserved despite the looser gate.

### 6. Run the per-provider matrix runs (optional but expected for #46)

For each non-default provider in
[`../providers/parity-matrix.md`](../providers/parity-matrix.md),
repeat steps 2–4 with that provider's credentials and aggregate
into [`../../packages/eval/parity.json`](../../packages/eval/parity.json).
Then refresh the rendered table:

```bash
pnpm --filter @review-agent/eval matrix:write
```

### 7. Commit

```bash
git add packages/eval/baseline.json packages/eval/parity.json docs/providers/parity-matrix.md
git commit -m "feat(eval): record measured baseline ($DATE, $MODEL_ID@$GIT_SHA)"
```

The commit message is purely conventional; CI does not parse it.
The `$DATE / $MODEL_ID / $GIT_SHA` in the message duplicates the
`measurement_metadata` block for grep-ability.

---

## What we deliberately do NOT automate

- **Per-PR re-measurement** — the cost is $2.20+ per run; running
  this on every PR would dominate `cost-cap-usd`.
- **Auto-aggregation** — the manual count step (§4) is small enough
  that a script would add more risk than value at 60 fixtures.
  Automate when the corpus exceeds 200 fixtures.
- **CI-blocking comparison against `baseline.json`** — the eval CI
  compares the *latest run* against the previous one's pass rates
  (`gates.precision_drop_max`, `gates.noise_rate_increase_max`).
  Adding a "current must equal baseline" gate would invert the
  intent: baseline is the *summary* of what the agent does well,
  not a target to chase.

---

## Cross-references

- [`../../packages/eval/baseline.json`](../../packages/eval/baseline.json) — the file
  this procedure populates.
- [`../../packages/eval/parity.json`](../../packages/eval/parity.json) — per-provider
  source data feeding the parity matrix.
- [`../providers/parity-matrix.md`](../providers/parity-matrix.md) — published
  per-provider table; depends on parity.json.
- [`./golden-prs.md`](./golden-prs.md) — fixture corpus design.
- [`../specs/review-agent-spec.md`](../specs/review-agent-spec.md) §14.3, §14.4 —
  source-of-truth definitions for precision / recall / FP rate /
  bypass count.
