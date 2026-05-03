# @review-agent/cli

Local CLI for `review-agent`. Run a one-off review against a single PR
using a Personal Access Token, validate `.review-agent.yml`, dump the
JSON Schema for IDE wiring, and recover state after a Postgres loss.

## Commands

```bash
review-agent review --repo owner/name --pr 42 --post
review-agent config validate [path]
review-agent config schema > schema/v1.json
review-agent eval --suite golden
review-agent recover sync-state --repo owner/name --installation 123
review-agent setup workspace                     # manual checklist (Anthropic Workspace + ZDR + spend cap)
review-agent setup workspace --api               # uses ANTHROPIC_ADMIN_KEY
```

`--post` is opt-in. The default `review` invocation prints the
findings to stdout without writing to GitHub — useful for prompt
tuning and gating.

## Bot identity

In CLI mode comments are posted under the PAT owner's user account
(e.g. `alice`). This is intentional for interactive operator use,
but means audit logs cannot distinguish "human reviewed" from "agent
reviewed via CLI". For multi-repo audit-trail uniformity use the
GitHub App (Server mode); see
[`docs/configuration/bot-identity.md`](../../docs/configuration/bot-identity.md).

## License

Apache-2.0
