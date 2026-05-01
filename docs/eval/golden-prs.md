# Golden PR fixtures

`packages/eval/fixtures/golden/` is the regression corpus for
`review-agent`. The CI gate fails when the agent's behaviour drops
below the rates declared in `packages/eval/baseline.json`.

Spec references: §14.3 (precision / recall / noise gates), §14.4
(50+ fixture target by v1.0).

---

## What's in the corpus (60 fixtures)

| Category | Count | What it tests |
|---|---|---|
| `known-bug/` | 20 | Real bug patterns: null deref / off-by-one / SQL injection / race condition / mutable defaults / leaks / etc. The agent must surface each. |
| `no-issue/` | 12 | Diffs that should produce zero substantive comments: doc typos, version bumps, comment clarifications, lint fixes. The false-positive gate. |
| `red-team/` (sibling dir) | 15 | Prompt-injection corpus from spec §7.3 #7. Counted toward the 50+ target. Index lives in `fixtures/red-team/manifest.json`. |
| `large-diff/` | 5 | Diffs ≥ 200 lines: rename refactors, lockfile updates, generated types, doc restructures, monorepo bootstraps. Stress-tests the path filter + cost cap. |
| `incremental/` | 3 | Cross-commit scenarios: fixup-after-feedback, force-push divergence, tests-only follow-up. Validates the `computeDiffStrategy` resolver. |
| `multi-language/` | 5 | PR title/body/comments in Japanese / German / Spanish. Validates the agent produces output in the matching `language:` config. |

Per-category targets are enforced by
`packages/eval/scripts/golden-validate.ts` — the validator fails the
build when a category falls below its target.

## Fixture file layout

`packages/eval/fixtures/golden/<category>/<id>/`:

| File | Required | What |
|---|---|---|
| `diff.txt` | yes | Unified diff that triggers the scenario. |
| `expected.json` | yes | Per-fixture assertions — see schema below. |
| `pr-meta.json` | optional | PR title / body / author overrides. The multi-language fixtures all have one; English fixtures usually default. |
| `README.md` | optional | Long-form context. The red-team category requires this; golden does not. |

### `expected.json` schema

```ts
{
  category: 'known-bug' | 'no-issue' | 'large-diff' | 'incremental' | 'multi-language',
  rationale: string,                        // required everywhere

  // Per-category extras (any of the following, depending on category):
  bug_class?: string,                       // known-bug only — taxonomy
  language?: string,                        // known-bug + multi-language
  severity_min?: 'must_fix' | 'consider' | 'nit',
  must_contain_any?: string[],              // regex patterns; at least one must match
  must_not_contain?: string[],              // regex patterns; none must match
  expected_comments?: number,               // no-issue / large-diff (often 0)
  expected_substantive_comments_max?: number,
  must_complete_within_seconds?: number,    // large-diff
  expected_resolved_fingerprints?: string[],// incremental
  expected_new_comments?: number,           // incremental
  previous_state?: { ... },                 // incremental
  current_state?: { ... },                  // incremental — for force-push test
  must_contain_japanese?: boolean,          // multi-language ja-JP
  must_contain_german?: boolean,            // multi-language de-DE
  must_contain_spanish_summary?: boolean,   // multi-language es-ES
  must_contain_japanese_summary?: boolean,
  must_contain_german_summary?: boolean,
}
```

The validator only enforces the base shape (`category` + `rationale`)
plus per-category category match. The richer assertions are evaluated
by the live promptfoo eval (see `packages/eval/promptfooconfig.yaml`).

## Adding a fixture

1. Pick the category. If you want a new category, edit
   `golden-validate.ts` + `baseline.json` + this doc in the same PR.
2. Choose an id matching `^[a-z0-9-]+$`.
3. Drop the diff + `expected.json` (and optionally `pr-meta.json`,
   `README.md`).
4. Add the fixture to `fixtures/golden/manifest.json`. The validator
   fails the build until the entry is present.
5. Run `pnpm --filter @review-agent/eval validate:golden` locally.

### Sourcing

> **Two-thirds of fixtures should derive from real PRs (with consent
> and anonymisation). One-third synthetic edge cases.**

Anonymisation procedure:

- Replace organisation / customer names with `acme` (or equivalent).
- Replace people's names with `alice` / `bob` / `carla` / `daisuke`.
- Replace internal repo names with generic ones (`my-package`,
  `widgets`, `cart-service`).
- Strip license headers that name a non-Apache-2.0 owner.
- Search for and remove URLs pointing at internal infrastructure.
- Rewrite identifying string literals (account ids, customer SKUs).
- Verify the diff still demonstrates the bug class — anonymisation
  shouldn't accidentally fix it.

For real-PR fixtures, capture the **original commit SHA + author
handle** in a private notebook, not in the fixture itself. The
fixture is permanently public; the audit trail isn't.

### Synthetic fixtures

Synthetic edge cases should:

- Be small (≤ 30 lines of diff) so the rationale is obvious.
- Pick *one* bug class. Mixing two creates ambiguous expected
  output.
- Use a real-looking framework / standard-library API. Don't invent
  `frobnicate(x)`; pick `Promise.all` / `bcrypt.compare` /
  `db.query`.

## Running the eval

```bash
# Quick shape validation (no LLM call, runs on every PR):
pnpm --filter @review-agent/eval validate:golden

# Full eval against the live model (requires ANTHROPIC_API_KEY):
pnpm --filter @review-agent/eval eval

# Red-team subset (fork-safe; runs separately in CI):
pnpm --filter @review-agent/eval validate:red-team
pnpm --filter @review-agent/eval eval:red-team
```

The cost target is **≤ $1 / CI run on the cheapest provider model**
(claude-haiku-4-5 / gpt-4o-mini / gemini-2.0-flash). Running against
the default Sonnet 4.6 costs ~$2.20 — used in the nightly precision-
tracking workflow rather than per-PR CI.

## Gate semantics (spec §14.3)

| Gate | Threshold | Source |
|---|---|---|
| known-bug precision | ≥ 90% | `baseline.json` `gates.known_bug_precision_min` |
| known-bug recall | ≥ 70% | `gates.known_bug_recall_min` |
| no-issue false-positive rate | ≤ 5% | `gates.no_issue_false_positive_max` |
| red-team bypass | 0 | `gates.red_team_bypass_max` |
| large-diff p99 wall time | ≤ 60s | `gates.large_diff_p99_seconds` |
| multi-language target-language match | ≥ 95% | `gates.multi_language_target_language_match_min` |
| precision drop vs prior baseline | ≤ 5% | `gates.precision_drop_max` |
| noise rate increase vs prior baseline | ≤ 10% | `gates.noise_rate_increase_max` |

A failure on any gate blocks merge.

## Drift after model upgrades

When the default model changes, the eval may shift on borderline
fixtures. Procedure:

1. Run the full eval against the new model on a feature branch.
2. For every fixture that flips: investigate whether the agent's
   behaviour changed (good) or the assertion was over-specific
   (loosen the regex). Record the decision in
   `docs/security/red-team.md` for red-team and inline in the
   fixture's `rationale` for golden.
3. Bump `baseline.json.recorded_at` and `model`. Update
   `current_pass_rates` if you have a new measurement.
4. Mention the upgrade in the PR description so future readers can
   trace the calibration.

## Maintenance schedule

- **Per release**: re-run the eval against the latest model; update
  `baseline.json` if the rates moved meaningfully.
- **Per quarter**: review the corpus for staleness. APIs / libraries
  the fixtures reference get renamed / deprecated; freshen the
  imports without changing the bug class.
- **Per discovered attack** (red-team only): add a fixture in the
  same PR as the patch. Always.

## CI integration

- `pnpm test` (root) runs `validate:golden` + `validate:red-team` on
  every PR — fast, no LLM call.
- `.github/workflows/red-team-eval.yml` runs the live red-team eval
  on PRs that touch runner / llm / fixtures.
- A v0.3.1 follow-up wires the live golden eval into a nightly
  workflow with the precision / recall gates above. Until then, the
  validator + manifest enforce the shape; the gates fire when the
  workflow lands.
