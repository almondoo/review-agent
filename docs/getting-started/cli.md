# review-agent CLI

The `review-agent` CLI is a **local-only** convenience surface for running
reviews against a single PR, validating config files, and re-running eval
suites. It is **not** a production runtime — there is no audit log, no
secret rotation, and no rate-limit-aware queueing. For production use the
GitHub Action (`@review-agent/action`) or the Hono webhook server
(`@review-agent/server`).

## Install

While the project is unpublished, install from the workspace:

```bash
pnpm install
pnpm --filter @review-agent/cli build
pnpm link --global --filter @review-agent/cli
```

You can now invoke `review-agent` from anywhere on your `PATH`.

## Authentication

| Variable | Required for | What |
|---|---|---|
| `REVIEW_AGENT_GH_TOKEN` (or `GITHUB_TOKEN`) | `review` | GitHub PAT with `pull_request: read/write` on the target repo |
| `ANTHROPIC_API_KEY` | `review` | Anthropic API key (default provider) |
| `REVIEW_AGENT_PROVIDER` / `REVIEW_AGENT_MODEL` | `review` (override) | Switch driver (`openai`, `azure-openai`, ...) |
| `REVIEW_AGENT_LANGUAGE` | `review` (override) | Output language (BCP-47) |
| `REVIEW_AGENT_MAX_USD_PER_PR` | `review` (override) | Hard ceiling on per-run LLM spend |
| `AWS_REGION` / `AWS_PROFILE` | `review --platform codecommit` | Standard AWS SDK credential chain (also picks up IRSA / EC2 metadata) |

Spec §8.3 + Appendix B has the full list. A PAT is fine for local use.
For org-scale or shared-team use, deploy the Action or webhook server
instead — they use a GitHub App with auditable token lifetimes.

## Subcommands

### `review --pr <n> --repo <owner/repo>`

Runs a full review against the named PR. Flags:

| Flag | Default | Notes |
|---|---|---|
| `--config <path>` | `.review-agent.yml` | Optional. Falls back to defaults when missing. |
| `--platform <github\|codecommit>` | `github` | VCS platform. `codecommit` reuses `--repo` as a bare repository name and authenticates via the AWS credential provider chain. |
| `--lang <code>` | (config) | BCP-47 — same set as `REVIEW_AGENT_LANGUAGE` |
| `--profile <chill\|assertive>` | (config) | Reviewer style |
| `--cost-cap-usd <usd>` | (config `cost.max_usd_per_pr`) | Hard ceiling on this run |
| `--post` | off | Publish comments + state to the PR. Default is dry-run. |

```bash
# Dry-run review printed to stdout (no PR mutation):
review-agent review --repo owner/repo --pr 42

# Same review, but actually post the comments back to the PR:
review-agent review --repo owner/repo --pr 42 --post

# Override config from CLI:
review-agent review --repo owner/repo --pr 42 \
  --lang ja-JP --profile assertive --cost-cap-usd 0.50
```

#### CodeCommit example

CodeCommit auth piggybacks on the AWS credential provider chain — no token
flag, no extra wiring. Set `AWS_REGION` (and any of `AWS_PROFILE`, IRSA,
EC2 metadata, etc.) and pass `--platform codecommit` with the bare
repository name as `--repo`:

```bash
AWS_REGION=us-east-1 AWS_PROFILE=my-profile \
  review-agent review --pr 42 --platform codecommit --repo demo-repo
```

Notes:

- `--repo` for CodeCommit is the **repository name** (no `owner/` prefix).
- The CLI does not accept an AWS access key directly — use the standard
  SDK environment variables or named profile so the same wiring works
  for `aws` CLI and other tooling.
- `recover sync-state` is GitHub-only on purpose; passing
  `--platform codecommit` short-circuits with an informative message
  (CodeCommit treats Postgres as the canonical state).

The dry-run summary lists each generated comment as
`[severity] path:line — first line of body` plus the model, tokens, cost,
and the run summary. Use `--post` only after you've reviewed the dry-run.

### `config validate [path]`

Loads `.review-agent.yml` (or the supplied path) and checks it against
the schema. Errors include the dotted path, a line number when the value
is locatable in the YAML AST, and the schema message.

```bash
review-agent config validate
review-agent config validate path/to/.review-agent.yml
```

Exit code: `0` on a clean validation, `1` on any issue.

### `config schema`

Prints the canonical JSON Schema for `.review-agent.yml` to stdout. Pipe
it into `schema/v1.json` to keep the committed copy in sync after a
schema update:

```bash
review-agent config schema > schema/v1.json
```

The committed file at `schema/v1.json` is the source of truth for IDE
autocomplete (`yaml.schemas` in VS Code's `settings.json`).

### `eval --suite <name>`

Delegates to `pnpm --filter @review-agent/eval test --suite <name>`. The
suite definitions live in `packages/eval/promptfooconfig.yaml`. v0.1
ships only `golden`; future suites can add adversarial / regression /
language-specific corpora.

```bash
review-agent eval --suite golden
```

## Caveats

- **No audit log**. Reviews run from this CLI do not append to the
  `audit_log` table — there is no DB. Use the server when you need an
  immutable record (spec §16.3).
- **No secret-scan failover**. The CLI does not currently shell out to
  gitleaks against your local clone before sending diffs to the LLM.
  Treat private repos and secret-bearing diffs as out-of-scope.
- **No rate-limit retries**. The CLI assumes you'll re-run by hand if the
  provider rate-limits you. The server does exponential-backoff with
  jitter (spec §17.1).
- **Profile flag is local-only**. `--profile` overrides config for this
  invocation; it is not saved back to disk. Same goes for `--lang` and
  `--cost-cap-usd`.

## Troubleshooting

```bash
# Dependencies not installed yet:
review-agent: command not found
# → pnpm install && pnpm --filter @review-agent/cli build && pnpm link --global --filter @review-agent/cli

# Wrong PAT scope:
review-agent: Failed to fetch PR: Resource not accessible by integration
# → Re-create the PAT with `pull_request: read & write`

# Anthropic key missing:
ANTHROPIC_API_KEY is required for the default Anthropic provider.
# → export ANTHROPIC_API_KEY=sk-ant-...
```

## See also

- [Action setup](./action.md) — for production GitHub Action use
- [Server setup](./server.md) — for self-hosted webhook + queue runtime
- [Spec §4.3](../specs/review-agent-spec.md) — CLI mode
