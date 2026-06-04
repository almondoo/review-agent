# Feedback Suppression Runbook

Issue #155 — false-positive suppression via 👎 signals.

## Overview

When a reviewer reacts 👎 (or issues `/feedback reject`) on an inline review
comment N times in a row (where N = `feedback.suppress_after`, default 3), the
runner automatically creates a **suppression rule** in `review_history`. Future
reviews skip any finding whose fingerprint matches an active suppression rule
and report the count in the run summary (`droppedBySuppression`).

## TTL warning

Suppression rules use the **same 180-day TTL** as all other `review_history`
rows. A rule that is not explicitly removed via `suppression remove` will expire
after 180 days. After expiry, the finding will reappear in the next review run.
If the user continues to reject it, the threshold will be crossed again and a
new rule will be created automatically.

**Operators who want permanent mutes** must either:
1. Monitor the expiry date shown by `suppression list` and use `suppression
   remove` + trigger a fresh rejection cycle before expiry, or
2. Reduce `feedback.suppress_after` to 1 so a single rejection always creates
   a rule (increases false-mute risk).

## Configuration

```yaml
# .review-agent.yml
feedback:
  suppress_after: 3   # default; min 1
```

## Inspecting active suppressions

```bash
review-agent suppression list \
  --installation-id <id> \
  --repo owner/repo
```

Output example:

```
Active suppression rules for owner/repo (2 rules):
  ID 42  fingerprint: abc123def456  created: 2026-06-01T00:00:00.000Z  expires: 2026-11-28T00:00:00.000Z
  ID 43  fingerprint: deadbeef0000  created: 2026-06-02T00:00:00.000Z  expires: 2026-11-29T00:00:00.000Z

To remove a rule: review-agent suppression remove --installation-id <id> --repo <repo> --rule-id <id>
```

## Removing a suppression rule (un-muting)

```bash
review-agent suppression remove \
  --installation-id <id> \
  --repo owner/repo \
  --rule-id 42
```

Output:

```
Suppression rule 42 removed from owner/repo. The finding will reappear on the next review run.
```

The operation is **idempotent**: re-running after the rule has already been
removed (or expired) outputs "not found" and exits 0.

## Metrics

| Metric | Description |
|--------|-------------|
| `review_agent_suppression_rules_created_total{repo}` | Counter incremented each time a new suppression rule is created. Feed this into a false-positive rate dashboard (C3). |

Wire the bridge in your server worker:

```typescript
import { bridgeSuppressionRulesCreatedToMetrics } from '@review-agent/server';

// Inside the FeedbackWriterOptions.suppressionOpts:
onSuppressionRuleCreated: bridgeSuppressionRulesCreatedToMetrics(),
```

## How the suppression pipeline works

1. **Feedback event received** (👎 reaction or `/feedback reject` command):
   - Platform adapter produces a `FeedbackEvent` with `kind: 'thumbs_down'`.
   - `createFeedbackWriter` writes a `rejected_finding` row with
     `factText: [fp:<fingerprint>] ...`.
   - After the write, the threshold checker runs:
     a. Count non-expired `rejected_finding` rows for `[fp:<fingerprint>]`.
     b. If count ≥ `suppress_after` AND no active `suppression_rule` exists
        for that fingerprint → insert a `suppression_rule` row.
     c. Errors are swallowed (fail-open) so the primary `rejected_finding`
        write is never blocked by a transient DB failure.

2. **Review run**:
   - Runner loads `suppression_rule` rows via `suppressionLoader`.
   - After dedup + confidence + ruleset filters, findings whose fingerprint
     matches a loaded rule are dropped.
   - `RunnerResult.droppedBySuppression` is populated (only when
     `suppressionLoader` is wired; `undefined` otherwise, for back-compat).

3. **Un-mute** (`suppression remove`):
   - Deletes the `suppression_rule` row by ID + installationId + repo (multi-
     tenant safe). The next review run re-emits the finding. If the user
     continues to reject it, a new rule will be created when the threshold is
     crossed again.

## Fingerprint scope

Suppression is scoped to **fingerprint** (path + line + ruleId +
suggestionType hash). This is the most conservative scope: the same semantic
finding at a different line, in a different file, or with a different rule will
NOT be suppressed. This prevents accidental over-suppression of a class of
finding across the whole codebase.

Operators who want to suppress an entire rule class should disable the category
via `.review-agent.yml` `reviews.ruleset.<category>.enabled: false`.
