# Trigger Control

This document describes how to control when review-agent runs a review: via
comment commands, label-based triggers, skip markers, and draft PR handling.

## Comment commands

The following slash commands may be posted in any PR comment (either a general
`issue_comment` or an inline `pull_request_review_comment`). All commands are
case-insensitive. Only the PR author and collaborators with **write** permission
or above may issue commands; unauthorized callers are silently ignored.

| Command | Effect |
|---|---|
| `/review` | Force a full re-review of this PR immediately. |
| `/review <path>` | Partial re-run scoped to the given path glob (e.g. `/review src/**`). |
| `/skip` | Pause auto-review on this PR until `/resume` is issued. |
| `/resume` | Resume auto-review after a `/skip`. |

The legacy `@review-agent review` prefix is also supported and behaves
identically to `/review`.

### Partial re-run path argument

A path argument is recognised when it contains at least one of `/`, `*`, `?`,
or `.`. Plain prose words (e.g. `/review please`) are treated as a full review
with no path scope.

### Debounce

If a review was started within the last 30 seconds for the same PR, a duplicate
`/review` command is silently dropped to avoid parallel runs. The window is
configurable via `deps.debounceMs` in the server worker wiring.

## Label-based triggers

Set `reviews.auto_review.trigger_labels` to fire a review when any of the
listed labels is applied to the PR:

```yaml
reviews:
  auto_review:
    trigger_labels:
      - needs-review
      - ready-for-review
```

When the `labeled` action fires and the applied label matches any entry in
`trigger_labels`, a full review is enqueued. Label matching is case-insensitive.

## Label-based skip

Set `reviews.auto_review.skip_labels` to suppress push-triggered auto-review
when any of the listed labels is currently on the PR:

```yaml
reviews:
  auto_review:
    skip_labels:
      - wip
      - no-review
      - do-not-review
```

The skip-label check applies only to push-triggered events (`opened`,
`synchronize`, `reopened`). It does **not** suppress `ready_for_review`
conversion (explicit user action) or `/review` commands.

## `[skip review]` marker

Add `[skip review]` anywhere in the PR **title or body** (case-insensitive) to
suppress auto-review for all pushes on that PR:

```
feat: add new endpoint [skip review]
```

The marker suppresses push-triggered auto-review only. A `/review` command
always overrides it.

## Draft PR handling

By default, draft PRs are skipped:

```yaml
reviews:
  auto_review:
    drafts: false   # default
```

When a draft is converted to ready-for-review, a `pull_request.ready_for_review`
event fires and auto-review runs (assuming all other conditions pass).

Set `drafts: true` to also review drafts on push.

## Pause / resume state

`/skip` sets a `paused = true` flag in the `review_state` table for the PR.
`/resume` clears it back to `false`.

While paused, **push-triggered auto-review is suppressed at the webhook
receiver**: `opened`, `synchronize`, and `reopened` events return without
enqueueing a job. The paused state persists across deployments (stored in
Postgres via the `review_state.paused` column, migration 0009).

The paused flag is checked by the **webhook handler** (not the worker) so the
suppression is immediate and does not consume SQS capacity. Fail-open on DB
read error: if the state cannot be read, the review proceeds normally.

`ready_for_review` (draft-to-ready conversion) is **not** affected by the
paused flag — an explicit conversion always fires auto-review regardless of
pause state.

## Debounce implementation

Review-agent uses `review_state.updated_at` as an in-process debounce guard:
if the last review update for a given PR is within 30 seconds of the current
request, duplicate commands are dropped. This is the minimal correct approach
for Standard SQS deployments; FIFO deployments additionally benefit from
SQS-native message deduplication via the job key.

## Priority / override hierarchy

1. `/review` or `@review-agent review` command — always enqueues (ignores
   `[skip review]` marker, `skip_labels`, and the `paused` flag).
2. `skip_labels` present on push event — suppresses.
3. `[skip review]` in title/body on push event — suppresses.
4. Paused state (`/skip`) — suppresses push-triggered events.
5. `auto_review.enabled: false` — suppresses all auto-review.
