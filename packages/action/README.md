# @review-agent/action

GitHub Action wrapper for `review-agent`. Composes `@review-agent/core` +
`platform-github` + `llm` + `runner` + `config` into a single Action entry
point.

## Inputs

| Input | Default | Notes |
|---|---|---|
| `github-token` | `secrets.GITHUB_TOKEN` | Used to post comments. Needs `pull-requests: write`. |
| `anthropic-api-key` | — | BYOK. Required for the default provider. |
| `language` | `en-US` | Output language for comments. Internal prompts are always English (spec §2.2). |
| `config-path` | `.review-agent.yml` | Path inside the repo. |
| `cost-cap-usd` | `1.0` | Hard cap per PR. |

## Outputs

- `posted-comments` — number of inline comments posted.
- `cost-usd` — USD cost of this run.

## Bot identity

In Action mode comments are posted by `github-actions[bot]` (the
identity tied to `secrets.GITHUB_TOKEN`). For multi-repo audit-trail
uniformity, run the GitHub App (Server mode) instead — see
[`docs/configuration/bot-identity.md`](../../docs/configuration/bot-identity.md)
for the per-mode mapping.

## License

Apache-2.0
