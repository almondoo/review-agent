# @review-agent/platform-github

GitHub VCS adapter for `review-agent`. Implements the `VCS` interface from
`@review-agent/core` against the GitHub REST API via `@octokit/rest`.

Supports two authentication modes:

- **PAT** (`createGithubVCS({ token })`) — Action mode (`GITHUB_TOKEN`) and
  CLI mode (`REVIEW_AGENT_GH_TOKEN`).
- **GitHub App** (`createAppAuthClient` + `createAppOctokitFactory`) —
  server mode, per-installation scoped tokens with DB-backed cache.

## GitHub App permissions

The App manifest must request (spec §8.2 verbatim):

| Permission | Access |
|---|---|
| `pull_requests` | write |
| `contents` | read |
| `issues` | write |
| `metadata` | read |

Webhook events subscribed: `pull_request`, `pull_request_review`,
`issue_comment`, `installation`, `installation_repositories`.

## App private key resolution

`loadPrivateKey(env)` reads exactly one of (precedence order):

1. `GITHUB_APP_PRIVATE_KEY_PEM` — inline. **Refused in production**
   unless `REVIEW_AGENT_ALLOW_INLINE_KEY=1`.
2. `GITHUB_APP_PRIVATE_KEY_PATH` — file mount.
3. `GITHUB_APP_PRIVATE_KEY_ARN` — AWS Secrets Manager
   (`@aws-sdk/client-secrets-manager`).
4. `GITHUB_APP_PRIVATE_KEY_RESOURCE` — GCP Secret Manager
   (`@google-cloud/secret-manager`).

If zero or more-than-one are set, startup fails fast.

## Token cache

`createAppAuthClient({ db, appId, privateKeyPem })` caches installation tokens
in the `installation_tokens` table. Cache window:
`expiresAt − 5 min`. On 401 from Octokit (handled by
`createAppOctokitFactory`), the client invalidates the row and refetches.

## Exports

- `createGithubVCS({ token, octokit?, runGit? })`
- `loadPrivateKey(env, fetchers?)`
- `createAppAuthClient({ appId, privateKeyPem, db })`
- `createAppOctokitFactory({ authClient })` — adds throttling + retry plugins
- `parseStateComment(body)` / `formatStateComment(state)`

## License

Apache-2.0
