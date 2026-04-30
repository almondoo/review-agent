# @review-agent/runner

Provider-agnostic agent loop for `review-agent`. Composes the system prompt
(profile + skills placeholder + path_instructions + language directive),
wraps PR metadata in `<untrusted>` tags, calls `LlmProvider.generateReview`
through middleware (injectionGuard → costGuard → main → dedup), retries once
on schema violation, and returns a validated `ReviewOutput`.

The skill loader, gitleaks integration, and incremental dedup logic plug in
later (v0.1 #07 / #08 / #09). This package ships the runner skeleton +
tool dispatch + middleware framework.

## Exports

- `runReview(job, provider, deps)` — main entry point.
- `composeSystemPrompt(opts)` — builds the English system prompt + language
  directive.
- `wrapUntrusted(metadata)` — `<untrusted>...</untrusted>` wrapper.
- `createTools(workspace)` — `read_file` / `glob` / `grep` exposed to the LLM
  with path validation, deny-list, and symlink refusal.
- `dispatchTool(name, args, tools)` — refuses anything outside the whitelist.
- `injectionGuard`, `costGuard`, `dedupMiddleware` — composable middleware.

## License

Apache-2.0
