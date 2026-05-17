# Review output schema

review-agent emits structured review output that conforms to a Zod
schema in `@review-agent/core` (`InlineCommentSchema` /
`ReviewOutputSchema`). The schema is the source of truth — every
provider (Anthropic, OpenAI, Azure, Google, Vertex, Bedrock) generates
output that matches it, so operators can aggregate findings across
providers without text-mining comment bodies.

This document covers the three optional fields the v1.1 schema attaches
to each inline comment — **`category`** (taxonomy), **`confidence`**
(operator-tunable suppression floor), and **`ruleId`** (stable identifier
for dedup + triage) — plus the operator-facing config keys that drive
them.

Spec reference: §7.7 (output validation schema).

---

## The `category` field

`InlineCommentSchema.category` is an **optional** enum with seven
values:

| Category          | Use when                                                                                  |
| ----------------- | ----------------------------------------------------------------------------------------- |
| `bug`             | Incorrect behavior, off-by-one, wrong logic, broken control flow.                         |
| `security`        | Authn/authz mistakes, injection, secret leak, SSRF, crypto misuse, unsafe deserialization. |
| `performance`     | N+1 queries, accidental O(n²), hot-loop allocation, missing index.                        |
| `maintainability` | Duplication, leaky abstraction, missing test seam, hard-to-change shape.                  |
| `style`           | Formatting, naming, idiom. Never higher than severity `minor`.                            |
| `docs`             | Missing or inaccurate comments, README/JSDoc drift, wrong example.                        |
| `test`            | Missing case, flaky test, brittle assertion, weak coverage of a critical path.            |

The taxonomy is intentionally small. If a comment plausibly fits
two categories, pick the one whose remediation work the reviewer
would route to: a SQL-injection finding is `security`, not `bug`,
because the on-call security engineer owns the fix.

`category` is optional for backward compatibility. Existing review
outputs without a category continue to validate; new outputs from the
LLM include a category whenever it is meaningful. Set
`InlineCommentSchema`'s `category` to `undefined` (or omit it) when
the comment is purely informational and does not map to a single
category.

---

## The `style → minor` rule

`InlineCommentSchema` enforces a single cross-field invariant:

> A comment with `category: 'style'` must use at most `severity: 'minor'`.
> A comment with `category: 'style'` and `severity: 'major'` (or
> `critical`) is **rejected by the schema**, even if the model emits it.

The rationale is operator-facing: style findings should never block a
PR. If a `style` finding genuinely warrants `major`, promote it to a
different category (most commonly `maintainability`).

The system prompt (`packages/runner/src/prompts/system-prompt.ts`)
instructs the model on this rule, but the Zod schema is the hard
backstop — a provider that ignores the prompt still cannot escalate
a `style` finding past `minor`.

---

## The `confidence` field

`InlineCommentSchema.confidence` is an **optional** enum with three
values:

| Confidence | Use when |
|---|---|
| `high`     | The model is sure the finding is real. Default for legacy / unannotated output. |
| `medium`   | Likely real but worth a human glance. |
| `low`      | Speculative; operator may want to suppress. |

Set the per-installation floor in `.review-agent.yml`:

```yaml
reviews:
  min_confidence: medium    # high | medium | low (default: low — post everything)
```

`min_confidence: 'high'` keeps only `high`. `'medium'` drops `low`.
`'low'` (default) keeps everything. Comments without a `confidence`
field are treated as `high` for back-compat — legacy reviews continue
to surface.

The filter runs **after** dedup so the fingerprint set on the kept
list stays well-formed. Suppressed comments are NOT memoised — flipping
the floor back from `high` → `low` lets the next review re-emit
previously-silent findings.

---

## The `ruleId` field

`InlineCommentSchema.ruleId` is an **optional** stable identifier (max
64 chars, regex `/^[a-z][a-z0-9-]+$/`). The dedup middleware
fingerprints findings by `(path, line, ruleId, suggestionType)`; with
no `ruleId` it falls back to severity, which collided whenever two
distinct findings on the same line shared a severity. Setting `ruleId`
eliminates that collision.

A non-exhaustive canonical taxonomy (the model is instructed to
prefer these IDs when applicable; otherwise invent a kebab-case ID
that two reviewers would converge on):

- Security: `sql-injection`, `path-traversal`, `xss`, `ssrf`, `unsafe-deserialization`.
- Correctness: `null-deref`, `off-by-one`, `missing-await`, `race-condition`.
- Performance: `n-plus-one`, `accidental-quadratic`, `hot-loop-alloc`.
- Maintainability: `duplicated-logic`, `leaky-abstraction`, `magic-number`, `unused-var`, `unused-import`, `long-function`.
- Style: `inconsistent-naming`, `dead-code`.
- Docs: `stale-comment`, `missing-doc`, `wrong-example`.
- Test: `flaky-test`, `missing-case`, `brittle-assertion`, `weak-coverage`.

When `ruleId` is unset, dedup uses severity as the fingerprint key —
existing reviews keep working byte-for-byte.

---

## Server-mode audit log

The Server-mode `audit_log` table records observability events
(`review.start`, `review.complete`, secret-leak verdicts, etc.). A
follow-up issue (see roadmap.md) will add a `category` column on the
`comment_posted` audit event so SIEM / BI tools can slice findings by
category. This work is intentionally separated from the schema change
documented here because:

1. The Server-mode emitter for `comment_posted` lands as part of the
   severity → GitHub review event mapping (issue #65), not the schema
   addition itself.
2. The hash-chain payload format requires a coordinated migration to
   include category in `canonicalPayload` without breaking
   verification of pre-existing rows.

In the meantime, callers can persist `category` to their own
observability sink (Datadog log line, S3 event stream, …) from the
`InlineComment.category` field on the posted comment.
