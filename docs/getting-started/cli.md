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

#### Approval-state mapping (opt-in)

By default the CLI does **not** mutate the CodeCommit pull-request approval
state when posting a review — it only writes inline comments and the
Postgres-backed state record. To let the agent map a request-changes
verdict onto `REVOKE` and an approval onto `APPROVE`, opt in via
`.review-agent.yml`:

```yaml
codecommit:
  approvalState: managed   # default: off
```

The CLI threads this value into `createCodecommitVCS({ approvalState })`
on every run, so the behaviour matches the server. See
[`packages/platform-codecommit/README.md`](../../packages/platform-codecommit/README.md#approval-state-mapping-74)
for the full mapping table and the IAM permissions required
(`codecommit:UpdatePullRequestApprovalState`).

The dry-run summary lists each generated comment as
`[severity] path:line — first line of body` plus the model, tokens, cost,
and the run summary. Use `--post` only after you've reviewed the dry-run.

### `review --local` — Local trial (no PR, no VCS credential)

Run the AI review pipeline against a **local diff** without any GitHub token
or VCS access. Local mode is activated by adding `--local`, `--sample`,
`--range`, or `--diff-file` to the existing `review` command. Useful as a
pre-commit gate, for evaluating review quality on historical diffs, or for
first-time users who want to try the agent before setting up a full GitHub
integration.

**Only `ANTHROPIC_API_KEY` is required** (or your configured LLM provider key).
No `REVIEW_AGENT_GH_TOKEN`, no `GITHUB_TOKEN`, no `--repo`, no `--pr`.

#### Diff sources (pick one; priority order)

| Flag | Source |
|---|---|
| `--sample` | Bundled multi-language sample diff (security + bug + performance findings). No git repo needed. |
| `--diff-file <path>` | Read a saved unified diff / patch file from disk. |
| `--range <a..b>` | Run `git diff <a..b>` in `--path` (or cwd). |
| `--local [path]` | Run `git diff HEAD` (working-tree changes) in `[path]` or cwd. |

#### Additional options (local mode)

| Flag | Default | Notes |
|---|---|---|
| `--path <dir>` | cwd | Target directory for git diff commands. |
| `--config <path>` | `.review-agent.yml` | Config file; falls back to defaults when missing. |
| `--fail-on <severity>` | `major` | Exit non-zero when any finding is at or above this severity. Values: `critical` `major` `minor` `info`. |
| `--lang <code>` | (config) | BCP-47 language override. |
| `--profile <chill\|assertive>` | (config) | Reviewer style. |
| `--cost-cap-usd <usd>` | (config) | Hard spend ceiling for this run. |

#### Exit code

- **0** — no findings at or above `--fail-on` severity (or diff is empty).
- **1** — one or more findings at or above `--fail-on`, or diff/auth error.

This makes `review-agent review --local` usable as a **pre-commit or CI gate**:
```bash
review-agent review --range HEAD~1..HEAD --fail-on major && echo "clean"
```

#### Examples

```bash
# Quickest start: run the bundled sample (no repo, no git needed):
ANTHROPIC_API_KEY=sk-ant-... review-agent review --sample

# Review your uncommitted working-tree changes:
review-agent review --local

# Review the last commit only:
review-agent review --range HEAD~1..HEAD

# Review a saved patch file, fail if any critical finding:
review-agent review --diff-file my.patch --fail-on critical

# Review a specific directory with a custom config:
review-agent review --local /path/to/repo --config /path/to/repo/.review-agent.yml

# Equivalent using --path:
review-agent review --local --path /path/to/repo --config /path/to/repo/.review-agent.yml
```

#### Config and presets

`.review-agent.yml` is fully honoured in local mode — `extends` (presets),
`ruleset`, `suggestions`, `large_pr`, `reviews.path_filters`, and all other
sections are resolved and applied exactly as in PR review mode.

#### What is NOT called

Local mode never touches VCS: no `getPR`, no `postReview`, no
`upsertStateComment`. The diff is the only input; findings go to stdout.

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
