# Review output schema

review-agent emits structured review output that conforms to a Zod
schema in `@review-agent/core` (`InlineCommentSchema` /
`ReviewOutputSchema`). The schema is the source of truth — every
provider (Anthropic, OpenAI, Azure, Google, Vertex, Bedrock) generates
output that matches it, so operators can aggregate findings across
providers without text-mining comment bodies.

This document covers the **`category`** taxonomy that is attached to
each inline comment.

Spec reference: §6 (output schema).

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

## Summary roll-up

`@review-agent/core` exposes `formatCategoryRollup(comments)` — a
pure helper that returns a markdown bullet list of category counts:

```md
### Findings by category
- bug: 3
- security: 1
- maintainability: 2
```

It is an **optional** formatter. Callers that compose the review
summary may append it; callers that prefer a free-form summary may
skip it. Categories appear in `CATEGORIES` order
(`bug → security → performance → maintainability → style → docs → test`)
for stable diffing. Comments without a category are silently ignored,
so a mixed (legacy + categorized) batch produces a partial roll-up
rather than an empty one.

If no comment has a category, the formatter returns the empty string
so it is safe to concatenate without producing an orphan header.

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
