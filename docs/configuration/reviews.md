# `reviews.{path_filters,max_files,max_diff_lines,max_steps}` — review scope and pipeline caps

`reviews.path_filters` plus the cap fields (`reviews.max_files`,
`reviews.max_diff_lines`, `reviews.max_steps`) decide **which files in a PR
the agent reviews at all**, **how big a PR may grow before the agent declines
to review it**, and **how many LLM round-trips the agent may spend** per
review. They are the operator's primary knobs for controlling cost, scope, and
reviewer signal-to-noise.

Spec reference: §10 (review scope rules), §10.2 (precedence).

## TL;DR

```yaml
reviews:
  # Glob patterns to EXCLUDE from review (drop matching files
  # entirely — they vanish from gitleaks scanning, auto-fetch, and
  # the LLM prompt). Empty = nothing filtered.
  path_filters:
    - "vendor/**"
    - "generated/**"
    - "docs/build/**"

  # Hard cap on file count after path_filters apply. Default 50.
  max_files: 50

  # Hard cap on total `+` / `-` diff lines after path_filters apply.
  # Default 3000.
  max_diff_lines: 3000

  # Maximum agent steps (LLM round-trips including tool-call
  # round-trips) before the agent stops. Default 20. Range 1–50.
  max_steps: 20
```

When either cap is exceeded, the agent **skips the review** without
calling the LLM and posts a single notice to the PR. Operators
respond by either widening the cap in `.review-agent.yml` or
splitting the PR. The exact wording is pinned below in
[Graceful skip wording](#graceful-skip-wording).

## Pipeline order

The cap pipeline runs **before** the gitleaks pre-scan and **before**
any LLM call:

```
job.diffText
  └─> parseDiffByFile        (split into per-file segments)
       └─> applyPathFilters  (drop matches; reviews.path_filters)
            ├─> max_files cap         (count vs reviews.max_files)
            ├─> max_diff_lines cap    (count vs reviews.max_diff_lines)
            └─> reassembleDiff        (rebuild diff for the LLM)
```

Each step is pure / I/O-free; the implementation lives in
`packages/runner/src/diff-filter.ts` and the wiring in
`packages/runner/src/agent.ts`.

### Cap-skip > gitleaks pre-scan (design decision)

When both a cap is exceeded **and** the diff contains a secret-shaped
token, the cap-skip takes priority — `SecretLeakAbortedError` is
**not** thrown. The operator-facing summary will be the cap-skip
wording, not a secret-leak alert.

Rationale:

- An operator who set `max_files: 50` is telling the agent "don't
  even look at PRs bigger than this". Scanning a 5 000-file PR for
  secrets just to then refuse the review wastes the gitleaks budget.
- The operator's signal-to-noise is preserved: one actionable PR
  comment ("PR too big") instead of a stack trace for a secret the
  operator already opted out of acting on by setting the cap.
- The PR author still gets the size signal first and can split the
  PR. Subsequent (smaller) PRs will be scanned normally.

Pinned by `packages/runner/src/agent.test.ts` →
`"cap-skip BEATS the gitleaks diff pre-scan (cost-guard alignment)"`.

If your threat model requires "always scan for secrets first,
regardless of cap", raise the cap (e.g. `max_files: 10000`) so the
cap pipeline never fires. The agent will then run the pre-scan on
every PR and surface `SecretLeakAbortedError` on a hit.

### `path_filters` = "completely ignore"

Files filtered out by `reviews.path_filters` are removed from
**every** downstream path the agent touches:

| Downstream consumer | Sees filtered files? |
|---|---|
| `gitleaks` diff pre-scan | No — filtered diff only |
| `gitleaks` output post-scan | No — never enters the LLM prompt |
| `auto_fetch` companion-file fetch (`path_instructions[*].auto_fetch`) | No — `changedPaths` is reduced |
| `read_file` / `glob` / `grep` (LLM-driven tools) | The tools can still read excluded paths if a `path_instructions[*].path` glob matches; if you also want to refuse tool reads, list the same prefix in `privacy.deny_paths` |
| The LLM prompt itself | No — the reassembled diff omits them |

The "filter out completely" semantic mirrors the operator's mental
model: "this directory is not my problem; do not spend any of the
agent's attention on it." Pinned by
`agent.test.ts` →
`"does NOT trigger SecretLeakAbortedError when the AKIA token lives only in an excluded path"`.

If you want to **filter from the review but still scan for secrets**,
do not use `path_filters` — that field is the wrong tool. Instead,
keep the files in scope and rely on `privacy.deny_paths` (for tool
access) plus the model's own judgement (it will see the diff but
can be steered with a `path_instructions` entry).

## `path_filters`

`reviews.path_filters` is an exclude-list of glob patterns (spec §10
L1435). Every entry is compiled with `globToRegExp` from
`@review-agent/core` and a file is dropped if **any** entry matches.
Empty list = no filtering (every file in the PR enters the review).

```yaml
reviews:
  path_filters: []                        # default — no filtering
```

```yaml
reviews:
  path_filters:
    - "vendor/**"
    - "third_party/**"
    - "generated/**"
    - "**/snapshot.test.ts.snap"
```

### Glob syntax

Same subset as `privacy.deny_paths` and `path_instructions[*].path`:

- `*` — any sequence within a single path segment.
- `**` — any sequence including `/` (recursive).
- `**/` — "zero or more segments, then a slash" (so
  `compliance/**/policy.txt` matches `compliance/policy.txt` AND
  `compliance/a/b/policy.txt`).
- Brace expansion (`{a,b}`), `?`, and character classes (`[...]`)
  are **not** supported. They are escaped as literals — `src/[abc]`
  matches only the literal four-character string `src/[abc]`, not
  any of the characters `a`, `b`, `c`.

Each pattern is anchored — equivalent to `^...$`. `vendor/**` does
NOT match `pkg/vendor/foo.ts`; use `**/vendor/**` for "any depth".

See [Glob caveats](#glob-caveats) below for case-sensitivity,
Windows-path, and Unicode-normalization details that mirror
`privacy.deny_paths` exactly.

### Glob caveats

`path_filters` shares its glob compiler with `privacy.deny_paths`,
which means it inherits the same three quirks. Rather than restate
the full discussion, this section points at the canonical writeup:

- **Anchoring** (`compliance/**` vs `compliance`): see
  [`privacy.md` → Anchoring gotcha](./privacy.md#anchoring-gotcha-compliance-vs-compliance).
- **Case-sensitivity** (operator patterns are case-sensitive; pair
  both casings on case-insensitive filesystems): see
  [`privacy.md` → Case-sensitivity](./privacy.md#case-sensitivity).
- **Windows backslashes / Unicode NFC↔NFD** (no implicit
  normalization, write the path bytes you have): see
  [`privacy.md` → Known limitations](./privacy.md#known-limitations).

The `tools.test.ts` and `diff-filter.test.ts` fixtures cited in
those sections all apply here — same compiler, same behaviour.

## `max_files`

Hard cap on the **post-`path_filters`** file count. Default `50`.

```yaml
reviews:
  max_files: 50    # default
```

Tighter values discourage giant PRs; looser values accommodate
intentional cross-cutting changes (monorepo migrations, lockfile
refreshes that touch hundreds of files):

```yaml
reviews:
  max_files: 200          # widen for a planned big PR run
  path_filters:
    - "pnpm-lock.yaml"    # still filter the noise
    - "package-lock.json"
```

The check is `filtered.files.length > job.maxFiles` — at the
boundary, `length === maxFiles` **passes**. Pinned by
`agent.test.ts` →
`"proceeds at the exact max_files boundary (filtered.length === maxFiles)"`.

## `max_diff_lines`

Hard cap on the total **`+` / `-` line count** across all files
that survived `path_filters`. Default `3000`.

```yaml
reviews:
  max_diff_lines: 3000    # default
```

### `countDiffLines` semantics

The count uses `+` / `-` payload lines only — the same units
`git diff --stat` reports. The following do **not** count:

- Context lines (start with a space).
- `\ No newline at end of file` markers.
- The hunk header (`@@ -... +... @@`).
- `+++ ` / `--- ` file-decoration lines (which can appear inside a
  body if the upstream patch embeds them).
- Preamble (any content before the first `--- <path>` marker —
  applies to test fixtures and anomaly input only; production
  `diffText` from action / cli has no preamble).
- Binary / rename-only entries (their patch body is empty, so they
  contribute 0).

Pinned end-to-end by `agent.test.ts` →
`"does not count `\ No newline at end of file` markers toward max_diff_lines (integration pin)"` and the per-line counter in
`diff-filter.test.ts`.

### Why payload-only counting matters

A 5-line block moved inside a 1 000-line file would produce a diff
with 5 `+`-lines, 5 `-`-lines, and ~990 context lines. Counting all
lines would put that "trivial" change at 1 000+; counting payload
only puts it at 10. Operators set `max_diff_lines` thinking in the
units `git diff --stat` shows them, and the cap pipeline matches
that intuition.

## Graceful skip wording

When either cap fires, the agent returns a `RunnerResult` with
`comments: []` and a `summary` that is **safe to post verbatim** to
a public PR comment. The exact strings (hard-coded English per
CLAUDE.md "internal prompts are always English"):

```
Review skipped: PR exceeds the max_files cap (<count> files > limit <maxFiles>). Adjust reviews.max_files in .review-agent.yml or reduce PR scope.
```

```
Review skipped: PR exceeds the max_diff_lines cap (<count> lines > limit <maxDiffLines>). Adjust reviews.max_diff_lines in .review-agent.yml or reduce PR scope.
```

Only operator-set numbers (counts, caps) are interpolated. No file
paths, hunk contents, or URLs appear in the summary — even when the
PR contained a path the operator might consider sensitive. This is
the same audit-only-summary discipline pinned by spec §7.3 #4
(retry-then-abort): the only string the agent posts publicly is
generic and operator-actionable.

The discriminator on `RunnerResult.aborted.reason` is
`'max_files_exceeded'` / `'max_diff_lines_exceeded'`. Both members
are added to `REVIEW_ABORT_REASONS` (`packages/runner/src/types.ts`),
so a downstream consumer that exhaustively switches on the union
will surface a compile error when these arrive — by design.

### `max_files` vs `max_diff_lines` priority

When **both** caps would fire on the same PR, the agent reports
`max_files_exceeded` first. This is documented (not implementation
detail): operators reading the summary see the most "first
principle" reason for the skip ("too many files" before "too many
lines"), and the priority is pinned by `agent.test.ts` →
`"checks max_files BEFORE max_diff_lines (file-count over-cap takes precedence)"`.

## `max_steps`

Hard cap on the number of **agent steps** — LLM round-trips including any
tool-call (`read_file` / `glob` / `grep`) round-trips within one review. Maps
to the Vercel AI SDK's `stopWhen: stepCountIs(N)`. Default `20`.

```yaml
reviews:
  max_steps: 20    # default (historical MAX_TOOL_CALLS constant)
```

Tune lower to keep latency and cost predictable; tune higher (up to 50) when
reviews of very large or multi-faceted PRs are hitting the cap too early and
the LLM is producing incomplete results.

### Env-var fallback: `REVIEW_AGENT_MAX_STEPS`

When the YAML does **not** set `reviews.max_steps`, the env var
`REVIEW_AGENT_MAX_STEPS` provides a deployment-level fallback:

```
REVIEW_AGENT_MAX_STEPS=30
```

**Precedence (highest → lowest):**

1. `reviews.max_steps` in `.review-agent.yml` (repo or org YAML).
2. `REVIEW_AGENT_MAX_STEPS` environment variable (only when YAML key is absent).
3. Built-in default: `20`.

This is the only `REVIEW_AGENT_*` env var that correctly implements the
§10.2 config-wins-over-env rule from the start. Other env vars (`LANGUAGE`,
`PROVIDER`, `MODEL`, `MAX_USD_PER_PR`) currently apply on top of the YAML —
a known precedence inversion that will be unified in a future follow-up.

**Out-of-range values** (below 1 or above 50) are rejected at config-load
time with an actionable error:

```
REVIEW_AGENT_MAX_STEPS='100' must be an integer between 1 and 50.
```

### `extends: org` merge behaviour

`reviews.max_steps` is a scalar: **repo overrides org**, same rule as
`max_files` and `max_diff_lines`. If the repo config does not set it, the
org default applies.

### Effective-config observability

The effective `max_steps` value is visible in the run's
`ConfigResolutionLog` (issue #146) output via the `reviews` section source:

```
config resolved: primary=repo-yaml org=false env=false [... reviews:repo-yaml ...]
```

## Defaults

| Field             | Default | Spec ref          |
|-------------------|---------|-------------------|
| `path_filters`    | `[]`    | §10 L1435         |
| `max_files`       | `50`    | §10 L1449         |
| `max_diff_lines`  | `3000`  | §10 L1450         |
| `max_steps`       | `20`    | §10 (§6.2 pattern) |

The defaults exist to give a brand-new operator a sensible review
budget on day one. They are **deliberately conservative** — most
PRs are small, and a PR that genuinely needs to be 5 000 lines is
usually a "split me first" signal.

## `extends: org` merge behaviour

For the [org-config layer](./extends.md), `reviews.path_filters`,
`reviews.max_files`, `reviews.max_diff_lines`, and `reviews.max_steps` follow
different merge rules:

| Field             | Merge rule                                                           |
|-------------------|----------------------------------------------------------------------|
| `path_filters`    | **Concatenated + de-duplicated** — `[...org, ...repo]` then `new Set`. Matches `privacy.deny_paths` / `privacy.allowed_url_prefixes` / `privacy.redact_patterns` (all globs-or-sets-of-strings follow this rule). |
| `max_files`       | **Repo overrides org.** Same as `cost.max_usd_per_pr`.               |
| `max_diff_lines`  | **Repo overrides org.** Same as `cost.max_usd_per_pr`.               |
| `max_steps`       | **Repo overrides org.** Same scalar rule as `max_files`.             |

### Why scalars are "repo wins" and not "stricter wins"

A natural alternative would be "the smaller cap wins" (so the org
sets a ceiling that repos cannot escape). We deliberately did NOT
implement that. Reasons:

1. **Consistency with every other scalar.** `language`, `profile`,
   `cost.max_usd_per_pr`, `cost.daily_cap_usd`, all of them are
   "repo wins". Adding a one-off "stricter wins" exception for two
   numeric fields would surprise operators and require a separate
   doc to explain when each rule applies.
2. **Escape hatch already exists.** Org admins who want to **lock**
   a cap simply remove `extends: org` from the org policy doc: the
   repo can either inherit the org default verbatim (no override)
   or fork off entirely, and the org-config resolver does not give
   the repo a "merge but ignore my caps" middle ground.
3. **Operator intent.** If a repo opts into `extends: org` and then
   raises the cap, that is a deliberate decision visible in code
   review of `.review-agent.yml`. The org admin can flag it in PR
   review of the repo config; nothing about it is silent or
   privilege-escalating.

Operators who need a hard org-level floor today should keep the cap
in the org file and rely on internal review of repo-level
`.review-agent.yml` overrides. A future major release may add an
opt-in `stricter_wins: true` flag on `extends`; this is not in v1.x.

### Example

`acme/.github/review-agent.yml`:

```yaml
reviews:
  path_filters:
    - "vendor/**"
    - "third_party/**"
  max_files: 100
  max_diff_lines: 5000
```

`acme/payments-service/.review-agent.yml`:

```yaml
extends: org
reviews:
  path_filters:
    - "vendor/**"          # also in org; deduped
    - "payments-generated/**"
  max_files: 50            # tighter than org
  max_diff_lines: 5000     # repo == org; no change
```

Effective config for `payments-service`:

- `reviews.path_filters` =
  `['vendor/**', 'third_party/**', 'payments-generated/**']`
  (concat then dedup; `vendor/**` appears once).
- `reviews.max_files` = `50` (repo overrides org).
- `reviews.max_diff_lines` = `5000` (repo == org; identical value).

## Operational checklist

- [ ] Decide a `max_files` that matches your team's "review-able PR"
      threshold. The default `50` is conservative for most repos.
- [ ] Set `max_diff_lines` against your tools' practical limit. The
      default `3000` lines aligns with `git diff --stat` budgets that
      most reviewers can absorb in one sitting.
- [ ] Add common-noise paths to `path_filters` (`vendor/**`,
      `generated/**`, lockfiles, autogenerated client SDKs). They
      should be **clearly excluded from human review too** — the
      filter says "we trust this, do not surface findings here".
- [ ] If you run gitleaks-only audits on excluded paths via a
      separate tool, document that elsewhere. The agent itself
      will not scan them.
- [ ] When a PR fails the cap, prefer splitting the PR over raising
      the cap. Raising the cap is one Git operation; reviewing a
      5 000-line PR responsibly is many hours of human attention.

## See also

- [`privacy.md`](./privacy.md) — `deny_paths` glob caveats reused by
  `path_filters` verbatim; `redact_patterns` for content-level
  hiding.
- [`extends.md`](./extends.md) — full merge-rule table including the
  three fields above.
- [`path-instructions.md`](./path-instructions.md) — per-glob review
  guidance that runs **inside** the surviving file set (i.e. after
  `path_filters` has trimmed the diff).
- [`coordination.md`](./coordination.md) — for the related "skip
  reviewing this PR entirely because another bot already commented"
  decision (lives upstream of the cap pipeline).
- `docs/specs/review-agent-spec.md` §10 — source of truth for the
  three fields and the default values.
