---
'@review-agent/core': minor
'@review-agent/llm': minor
'@review-agent/runner': minor
'@review-agent/config': minor
'@review-agent/platform-github': minor
'@review-agent/platform-codecommit': minor
'@review-agent/server': minor
'@review-agent/cli': minor
'@review-agent/db': minor
'@review-agent/action': minor
'@review-agent/eval': minor
---

v1.0.1 + v1.1 wave — 13 issues + 4 reviewer-fix follow-ups (17 commits on `develop`).

**v1.0.1** (architectural-gap hotfixes from the v1.0 multi-agent audit):

- #59 expose `read_file` / `glob` / `grep` tools to the LLM. Agent loop switches from `generateObject` to `generateText({ tools, stopWhen: stepCountIs(MAX_TOOL_CALLS=20), experimental_output: Output.object({ schema: ReviewOutputSchema }) })`; tool count surfaces on `RunnerResult.toolCalls` for cost-guard accounting.
- #60 wire incremental diff via `sinceSha`. The 2nd+ review of a PR now sends only the delta to the LLM; the action logs `'incremental review'` / `'rebase detected'` on each path.

**v1.1**:

- #61 explicit severity rubric + what-NOT-to-flag + suggestion guidance in `BASE_SYSTEM_PROMPT`.
- #62 retry + fail-loud on state-comment write failure (new action input `state-write-retries`, range 0-5, default 3).
- #63 provision per-job workspace in Server mode (new `server.workspace_strategy` config: `none` / `contents-api` / `sparse-clone`).
- #64 add optional `category` field to `InlineCommentSchema` (`bug` / `security` / `performance` / `maintainability` / `style` / `docs` / `test`); enforces `style → minor` invariant via `.refine`.
- #65 map severity → GitHub review event. Critical findings can flip the event to `REQUEST_CHANGES`; configurable via `reviews.request_changes_on`. `computeReviewEvent` exported from core.
- #66 surface commit messages + PR labels + base branch into the `<untrusted>` envelope so the LLM can read author intent. GitHub adapter fetches the last page of `listCommits` only (single API call on typical PRs).
- #67 audit retention + export CLI (`review-agent audit export` / `audit prune`). HMAC-chain segment verification pre-export and post-prune.
- #68 severity-consistency assertions in eval (6 golden fixtures, N=3 promptfoo runs, baseline-gate at 5pp drop ceiling).
- #69 add optional `confidence` + `ruleId` to `InlineCommentSchema`. New `reviews.min_confidence` config drops `low` findings before posting. `ruleId` upgrades dedup precision (resolves same-line-same-severity collisions).
- #70 path_instructions auto-fetch + glob validation. New `auto_fetch: { tests, types, siblings }` field on `path_instructions[i]` pre-fetches related files into a `<related_files>` block inside the `<untrusted>` envelope (budget 5 files / 50 KB each / 250 KB total).
- #71 stronger `ReviewState` validation via Zod schema (`ReviewStateSchema` exported from core); corrupted state-comments now drop + emit `state_schema_mismatch` audit event instead of silently feeding stale baseSha into dedup.

All additions are backwards-compatible. Existing `.review-agent.yml` files keep working byte-for-byte; existing `runReview` / `wrapUntrusted` / `postReview` call sites compile unchanged. See `UPGRADING.md` § "From 1.0 → 1.1" for the full operator migration guide.

Reviewer-fix commits (operationally invisible but improve security / correctness):

- `bfcd769` #67 retention.md per-tenant RLS scope + required DB role.
- `215abed` #66 `getPR` fetches only the last page of `listCommits` (was paginating all pages then slicing — pathological 1000-commit rebases burned 10× the rate-limit budget).
- `15ac9c3` #63 align workspace-provisioner denylist with the runner's tool-dispatcher denylist (`.aws/credentials` was missing — bytes-on-disk gap).
- `ffe6aa6` #70 move `<related_files>` inside the `<untrusted>` envelope (auto-fetched files are author-controlled bytes; previous placement outside the envelope was a new prompt-injection surface).

Final regression: 823/823 unit tests green; typecheck / lint / build green across all 12 packages.
