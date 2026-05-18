# Feedback loop — `review_history` writer

Spec references: §7.6 (learned facts), v1.2 epic [#83](https://github.com/almondoo/review-agent/issues/83) Phase 3 ([#92](https://github.com/almondoo/review-agent/issues/92)).

## Signals collected

Phase 3 records **explicit** human feedback on the agent's inline
comments. The decision (epic #83 Open question Q2) is intentionally
narrow — LLM-based interpretation of free-text reply bodies is
deferred to a later issue. Three signals are recognised:

| Signal | Source webhook event | `factType` |
|---|---|---|
| `thumbs_up` | `reaction` / `pull_request_review_comment_reaction` with `content: '+1'` | `accepted_pattern` |
| `thumbs_down` | same family with `content: '-1'` | `rejected_finding` |
| `dismissed` | `pull_request_review` with `action: 'dismissed'` | `rejected_finding` |

Other reactions (`heart`, `laugh`, `eyes`, etc.) are noise and the
receiver drops them. Only `action: 'created'` reactions count — a
later `delete` or `edit` does not undo the previously-recorded row.

## Receiver-side flow

```
GitHub webhook
    │
    ▼
handleWebhook(...)             ← packages/server/src/handlers/webhook.ts
    │  classifies reaction / dismissed
    ▼
WebhookResult { kind: 'feedback', signal, commentId }
    │
    ▼
operator worker handler        ← user code in your Lambda / Fargate handler
    │  resolves commentId → fingerprint via your DB or GitHub API
    │  builds FeedbackEvent
    ▼
createFeedbackWriter(...)      ← packages/runner/src/feedback-writer.ts
    │  PII redact + rate-limit + factType mapping
    ▼
createReviewHistoryWriter(db)  ← packages/db/src/review-history.ts
    │
    ▼
review_history table (Postgres)
```

The receiver intentionally does **not** enqueue feedback into the
review-job queue — the existing `JobMessage` shape is for review
runs, not feedback writes. Operators wire feedback through a
separate code path (typically a thin async handler in the same
Lambda).

## Writer guarantees (`createFeedbackWriter`)

| Concern | Behaviour |
|---|---|
| PII / secret leakage | `factText` is scanned with the same gitleaks built-in ruleset as the review path. Matches are replaced with `[REDACTED:<ruleId>]` before insert. Operator-supplied `privacy.redact_patterns` extend the rule set; invalid regexes are silently dropped (matching the runtime behavior). |
| Rate-limit | Default 10 writes per writer instance. Excess events are dropped and reported via the optional `onRateLimit` hook. Operators construct **one writer per job** so the cap scopes correctly. |
| Fact-type discriminator | `feedbackKindToFactType` is the single source of truth: `'thumbs_up'` → `'accepted_pattern'`; `'thumbs_down'` / `'dismissed'` → `'rejected_finding'`. Phase 4's reader uses the same function on the way out. |
| Fingerprint linkage | The writer prefixes `factText` with `[fp:<fingerprint>]` so Phase 4 can route facts to the matching comment fingerprint without a new DB column. |
| TTL | The schema's `expires_at` default is `now() + 180 days`. The writer does not touch it. Pruning is a separate concern — see `pruneExpiredReviewHistory` in `@review-agent/db`. |

## Example operator wiring

```ts
import { createFeedbackWriter } from '@review-agent/runner';
import { createReviewHistoryWriter, createDbClient, withTenant } from '@review-agent/db';

const db = createDbClient({ url: process.env.DATABASE_URL });
const historyWriter = createReviewHistoryWriter(db);

async function onReactionWebhook(result: WebhookResult, payload: GitHubReactionPayload) {
  if (result.kind !== 'feedback') return;
  const fingerprint = await resolveCommentFingerprint(payload);
  if (!fingerprint) return; // not one of our comments

  const writer = createFeedbackWriter({
    writer: historyWriter,
    redactPatterns: reviewerConfig.privacy.redact_patterns,
    onRateLimit: (ev) => log.warn({ ev }, 'feedback rate limit hit'),
  });

  await withTenant(installationId, async () => {
    await writer.record({
      installationId,
      repo: `${payload.repository.owner.login}/${payload.repository.name}`,
      prNumber: payload.pull_request.number,
      fingerprint,
      kind: result.signal,
      factText: payload.reaction.user.login + ' reacted ' + payload.reaction.content,
      occurredAt: new Date(payload.reaction.created_at),
    });
  });
}
```

## Out of scope (deferred to later issues)

- **LLM-based comment-reply interpretation** (epic #83 Q2). "thanks,
  fixed!" / "this is a false positive" responses are not classified
  by Phase 3.
- **Accepted-pattern collection beyond 👍** (Q3). Two other signals
  considered (N-PRs-without-dismiss, suggestion adopted into a
  commit) are deferred.
- **GraphQL Resolve conversation state**. REST cannot fetch the
  resolved-vs-open state of a conversation, so it is not consulted.
