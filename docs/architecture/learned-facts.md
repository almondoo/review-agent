# `<learned_facts>` injection + feedback-aware dedup

Spec references: §7.6 (learned facts), §7.6.1 (writer/reader implementation), v1.2 epic [#83](https://github.com/almondoo/review-agent/issues/83) Phase 4 ([#93](https://github.com/almondoo/review-agent/issues/93)).

## What this closes

Phase 4 wires the **reader side** of the spec §7.6 closed loop:

```
[earlier reviews]
        │
        ▼ Phase 3 / #92 — humans react / dismiss
review_history (rejected_finding | accepted_pattern | arch_decision)
        │
        ▼ Phase 4 / #93 — runner reads at next runReview
composeSystemPrompt({ learnedFacts: [...] })
        │       (positive guidance for 👍, suppression for 👎)
        ▼
dedupComments({ rejectedFingerprints: [...] })
        │       (dropped count surfaces as droppedByFeedback)
        ▼
review_eval_event.dropped_by_feedback
        (Phase 2 / #91 metrics table — ready for before/after analysis)
```

## Operator wiring

Provide a `historyReader` and `evalContext` to `runReview`:

```ts
import { runReview } from '@review-agent/runner';
import { loadRecentReviewHistory, createDbClient, withTenant } from '@review-agent/db';

const db = createDbClient({ url: process.env.DATABASE_URL });

await withTenant(installationId, async () => {
  await runReview(job, provider, {
    evalContext: { installationId, prNumber, headSha },
    historyReader: async ({ installationId, repo, limit }) =>
      loadRecentReviewHistory(db, { installationId, repo, limit }),
    // ... rest of deps (evalRecorder, etc.)
  });
});
```

The reader returns up to `MAX_LEARNED_FACTS` (default 50, spec §7.6)
rows ordered desc by `created_at`. The runner is responsible for
splitting them into the prompt section and the `rejectedFingerprints`
backstop.

## Failure mode

A transient DB outage in `historyReader` **bubbles up** rather than
silently skipping the section. The reasoning: a skipped section
erases the learning signal without warning, and the operator can
choose how to react (retry, surface in OTel, fall back to a
no-history review). The eval recorder (Phase 2) is the opposite —
fail-open after a successful post — because by then the comments
are already on the PR.

## Why `[fp:<fingerprint>]` prefix on `factText`

The writer (Phase 3) encodes the originating comment's fingerprint
into the otherwise free-text `fact_text` column so:

1. The reader can extract `rejectedFingerprints` without joining
   to a separate index table.
2. Phase 4's "drop count" metric works on real fingerprints, not
   heuristic substring matches.
3. The schema stays at `text` and avoids another migration.

Rows that predate the writer (or were hand-edited) have no
prefix; the runner silently drops them from the
`rejectedFingerprints` list and still uses them in the prompt
section.

## Measuring the loop's effect

Phase 4 plumbs `dedup.droppedByFeedback` into `RunnerResult` and
on to the `review_eval_event.dropped_by_feedback` column. Together
with `dropped_duplicates` and `comment_count`, this lets the
operator answer:

- Did Phase 3's feedback signals reduce the noisy comment count?
- Are 👎 reactions clustering on a single rule_id we should tune?
- Is the `<learned_facts>` section *actually* shifting the LLM's
  output, or is the dedup backstop carrying the win alone?

A SQL recipe lives in `docs/eval/` (alongside the existing
baseline-measurement workflow).
