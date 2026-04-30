# @review-agent/platform-github

GitHub VCS adapter for `review-agent`. Implements the `VCS` interface from
`@review-agent/core` against the GitHub REST API via `@octokit/rest`.

v0.1 supports PAT authentication only (`GITHUB_TOKEN` for Action mode,
`REVIEW_AGENT_GH_TOKEN` for CLI mode). GitHub App authentication is added in
v0.2 (#14).

## Exports

- `createGithubVCS({ token, octokit?, runGit? })` — returns a `VCS` instance.
- `parseStateComment(body)` / `formatStateComment(state)` — hidden-comment marker helpers.

## Hidden state comment format

```
<!-- review-agent-state: { "schemaVersion": 1, ... } -->
```

Per spec §12.1. The marker is the source of truth on GitHub; Postgres mirrors
it for query convenience but the comment wins on conflict.

## License

Apache-2.0
