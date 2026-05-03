# Multi-bot coordination

When multiple PR review bots are installed on the same repository (for
example `coderabbitai[bot]` alongside `review-agent`), the default
behaviour is **independent review**: every bot reviews every PR, and
review-agent's own dedup (`<!-- review-agent-state: ... -->` +
per-finding fingerprint) only suppresses repeats of *its own* prior
comments. There is no cross-bot suppression by default.

Spec reference: §22 #9. The deferred design question — "should we
recommend a single shared identity for audit-trail uniformity?" — is
answered here for v1.0.

---

## Decision

`review-agent` ships with three coordination stances:

| Stance | Setting | When to use |
|---|---|---|
| Review every PR independently (default) | `coordination.other_bots: ignore` | Single-bot installations, or installations where each bot serves a distinct purpose (review-agent for diff review, a security-only bot for SAST). |
| Defer when another known review bot is present | `coordination.other_bots: defer_if_present` | Installations running two general-purpose review bots in parallel — keep one as primary, defer to whichever posts first. |
| Skip review-agent entirely (manual) | Not implemented as config | Use `reviews.auto_review.enabled: false` and trigger reviews via a manual workflow if needed. |

`defer_if_present` is opt-in. The default is `ignore` because:

1. Most installations run a single review bot. Adding a deference
   mechanism by default would create a "silent skip" surprise.
2. Even when two bots coexist, the operator may *want* both signals
   for a few reviews before consolidating to one.
3. The detection check costs a `pulls.listReviewComments` call per
   PR; charging it in `ignore` mode for the 95% case would be wasteful.

---

## Configuration

```yaml
# .review-agent.yml
coordination:
  other_bots: defer_if_present     # default: ignore
  other_bots_logins:               # default: []  (additive to built-in list)
    - acme-internal-reviewer[bot]
```

### Built-in detection list

The following GitHub App actors are detected automatically (defined in
`packages/config/src/known-bots.ts`):

- `coderabbitai[bot]`
- `qodo-merge[bot]`
- `pr-agent-bot[bot]`
- `bedrock-pr-reviewer[bot]`

Adding to `coordination.other_bots_logins` extends this set; you
cannot remove built-in entries through config (use `ignore` if you
don't want any deference).

### Match semantics

- Match is on **exact** GitHub login including the `[bot]` suffix.
  `CodeRabbitAI[bot]` does not match `coderabbitai[bot]`, and
  `coderabbit-fan` (a hypothetical human) does not match
  `coderabbitai[bot]`. This is deliberate — partial / case-insensitive
  matches risk false positives against humans.
- Detection looks at **inline review comments only** (the GitHub
  `pulls.listReviewComments` endpoint). Bots that post *only* a
  single summary PR comment via `issues.createComment` (no inline
  comments at all) are **not detected** in v1.0, even when added to
  `coordination.other_bots_logins`. The login override extends the
  detection set, but the underlying API call only returns inline
  authors. Extending the VCS adapter to also list issue-level
  comments is tracked as a v1.x improvement; until then, treat
  `defer_if_present` as inline-comment-bot only.
- The check runs **once per webhook**, before the agent loop. There
  is no race-resolution: whichever bot posts first wins, and the
  other defers on the next event.

---

## Operational behaviour

When `defer_if_present` matches a known bot:

1. `review-agent` posts a single skip-summary comment naming the
   detected bot and the override path:

   > ### review-agent — skipped
   >
   > Detected an existing review by `coderabbitai[bot]`.
   > `coordination.other_bots` is set to `defer_if_present`, so this
   > run will not post additional comments.
   >
   > To override, set `coordination.other_bots: ignore` in
   > `.review-agent.yml` (or remove the key entirely — `ignore` is
   > the default).

2. No inline comments and no hidden `review-agent-state` row are
   posted. The next event (push, PR re-open) re-evaluates from
   scratch — there is no persistent "this PR was deferred" flag.
3. The result returned to the runner / Action / Server reports
   `skipped: true` with `skipReason: "Deferred to '<bot>' (coordination policy)"`.
4. No LLM call is made; no cost is incurred.

If the other bot posts after `review-agent` has already run, no
deference happens. The dedup mechanism handles repeat events from
`review-agent` itself, but does not retroactively erase posted
comments. If you want to swap the primary bot mid-flight, configure
`reviews.auto_review.enabled: false` for the secondary explicitly.

---

## Why no automatic shared identity?

We considered making `review-agent` post under a shared `[review-bot]`
identity to give auditors a single uniform actor across modes. Two
reasons we didn't:

1. GitHub already determines the actor per auth method (Action ↔
   `github-actions[bot]`, App ↔ `<app-name>[bot]`, PAT ↔ user). A
   config knob would create an *inconsistent* second source of truth
   that could drift from what GitHub reports in the UI.
2. The fingerprint dedup in `packages/runner/src/middleware/dedup.ts`
   is identity-agnostic — identical content is suppressed regardless
   of which actor would post it. So uniformity is unnecessary for
   the dedup correctness story; it only helps audit-trail reading.

For audit-trail uniformity, see
[`./bot-identity.md`](./bot-identity.md) for the recommended
distribution-mode mapping.

---

## Multi-bot installations: a few patterns

| Pattern | Setting | Notes |
|---|---|---|
| Single bot (default) | omit `coordination` | Schema defaults handle it. |
| review-agent + coderabbit, prefer either | `defer_if_present` on both bots | Whichever posts first wins; the other skips. Slightly racey but cheap. |
| review-agent primary, secondary security bot only | `ignore` on review-agent; configure the secondary not to react to PRs review-agent has already commented on (per its own settings). | Keeps both signals; relies on the secondary having its own coordination knob. |
| Org policy: review-agent only on certain repos | `reviews.auto_review.enabled: false` on the others | Honours operator intent without depending on inter-bot detection. |

The detection list (`packages/config/src/known-bots.ts`) is updated
manually per-release as new bots are reported. Open an internal issue
if you encounter a coexistence scenario the static list doesn't cover.
