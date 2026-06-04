# Conversation Replies (`@review-agent` follow-ups)

review-agent can respond to replies on its own inline findings. When a user
mentions `@review-agent` in a reply to one of the agent's inline review
comments, the agent posts a context-aware response in the same thread.

## Configuration

```yaml
reviews:
  max_conversation_turns: 5  # default: 5, range: 1–50
```

`max_conversation_turns` caps the total number of back-and-forth agent replies
per thread. When the limit is reached the agent posts a single
"conversation limit reached" note and stops replying.

## Behavior

### Happy path

1. User replies to an agent inline finding with `@review-agent <question>`.
2. The webhook receiver detects a `pull_request_review_comment` event with
   `in_reply_to_id` set and `@review-agent` in the body.
3. The agent checks authorization (collaborator write permission required).
4. The turn counter for the thread is incremented.
5. An LLM call is made with the original finding, diff hunk, prior thread
   turns, and the user's message as context.
6. The cost is recorded against the PR cost ledger.
7. The reply is posted as a threaded reply in the same inline comment thread.

### Guards

| Scenario | Behavior |
|---|---|
| Sender is the bot itself (`sender.login === bot login`) | Silent no-op (`self_reply`). |
| Sender lacks write permission on the repository | Silent no-op (`unauthorized`). |
| `max_conversation_turns` exceeded | Posts a single limit-reached note, then stops. |
| PR cost cap exceeded | Silent no-op (`cost_exceeded`). No reply posted. |
| Platform does not support thread replies (CodeCommit) | Silent no-op (`capability_unsupported`). |

### Self-reply loop prevention

The server wires a `getBotLogin` callback that calls
`octokit.rest.apps.getAuthenticated()` and caches the result. The bot login
follows the `<slug>[bot]` pattern (e.g. `review-agent[bot]`). The webhook
handler compares `sender.login` against this value before routing to the
conversation handler.

### Platform support

| Platform | Supported |
|---|---|
| GitHub | Yes — uses `pulls.createReplyForReviewComment`. |
| CodeCommit | No — CodeCommit has no native thread-reply API. The capability guard `conversationReply: false` prevents any LLM call from being made. |

## Cost accounting

Each agent reply is a separate LLM call recorded in the `cost_ledger` table
with `call_phase: 'review_main'`. The PR cost cap (`cost.max_usd_per_pr`) is
checked before the LLM call; if the running cost exceeds the cap the reply is
silently skipped.

## Turn tracking

Turn counts are persisted in the `conversation_threads` table (migration
`0010_conversation_threads`). The natural key is
`(installation_id, repo, pr_number, root_comment_id)` where `root_comment_id`
is the id of the first bot comment that started the thread. All replies in
that thread share the same root comment id.
