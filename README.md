# review-agent

Self-hosted, BYOK AI code-review agent for GitHub Pull Requests.

> Personal project — published as open source for reference, not accepting
> external contributions. Forks are welcome.

## What it does

`review-agent` runs as a GitHub Action on your PRs. It:

- Posts inline comments tied to specific lines, plus a single summary
  comment per review. Each comment carries optional `category` (bug /
  security / performance / maintainability / style / docs / test),
  `confidence` (high / medium / low), and `ruleId` so operators can
  aggregate, suppress, and dedupe findings across providers.
- Calibrates severity against a published rubric (critical / major /
  minor / info with before/after examples) baked into the system
  prompt, and switches the GitHub review event to `REQUEST_CHANGES`
  on critical findings (opt-in via `reviews.request_changes_on`).
- Deduplicates findings across pushes via a hidden state comment
  (`<!-- review-agent-state: ... -->`) and per-finding fingerprints,
  and sends only the **incremental** diff to the LLM on the 2nd+
  push so reviewers don't pay for the whole PR on every commit.
- Exposes `read_file` / `glob` / `grep` tools to the model so it can
  pull in test companions, type declarations, and siblings as it
  reviews — bounded by a per-review `MAX_TOOL_CALLS` budget plus an
  auto-fetch budget on `path_instructions[i].auto_fetch`.
- Honours an opt-in `.review-agent.yml` config — language, profile
  (`chill` / `assertive`), provider/model, cost cap, ignored authors,
  path-scoped instructions (with auto-fetch + glob validation),
  skills, confidence floor, severity threshold for REQUEST_CHANGES,
  and (Server mode) workspace strategy.
- Scans diffs and any agent-collected text with [`gitleaks`](https://github.com/gitleaks/gitleaks)
  before posting; aborts review on secret leakage in agent output.
- Runs in a non-root sandboxed Docker container with denylisted paths
  (`.env*`, `.git/`, `node_modules/`, `.aws/credentials`, secret stores)
  enforced at BOTH the provisioner and the tool dispatcher, and
  partial+sparse clone of just the changed paths.
- Caps cost per PR (`cost-cap-usd`, default `1.0`) and short-circuits
  the agent loop the moment the cap is reached.
- Ships a `review-agent audit export` / `audit prune` CLI for
  operator-driven retention of `audit_log` / `cost_ledger`, with
  HMAC-chain re-verification on prune (Server mode).
- Retries the state-comment write on transient GitHub failures
  (configurable via the `state-write-retries` action input) and fails
  loud on exhaustion so the next push doesn't silently re-review the
  whole PR.

## Quick start (GitHub Action)

```yaml
# .github/workflows/review.yml
name: review-agent
on:
  pull_request:
    types: [opened, synchronize, ready_for_review]

permissions:
  contents: read
  pull-requests: write

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: almondoo/review-agent@v0  # pin a tag in production
        with:
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
          language: en-US
          cost-cap-usd: '1.0'
```

Add `ANTHROPIC_API_KEY` to your repository secrets. The default
`secrets.GITHUB_TOKEN` is used to post comments.

## Configuration

Drop a `.review-agent.yml` at your repository root. Every field is
optional; defaults are spec-aligned and conservative.

```yaml
language: en-US                  # ISO 639-1 + region
profile: chill                   # chill | assertive
provider:
  type: anthropic
  model: claude-sonnet-4-6
reviews:
  auto_review:
    drafts: false                # skip until ready_for_review
  ignore_authors:                # default skips dep bots
    - dependabot[bot]
    - renovate[bot]
    - github-actions[bot]
  path_instructions:
    - path: "packages/core/**"
      instructions: "Public API. Flag breaking changes explicitly."
skills:
  - .claude/skills/security.md   # user-supplied skills only at v0.1
```

The full schema lives in [`schema/v1.json`](./schema/v1.json) and powers
IDE autocomplete via:

```json
// .vscode/settings.json
{ "yaml.schemas": { "./schema/v1.json": [".review-agent.yml"] } }
```

## How a review runs

1. Action loads `.review-agent.yml`, reads PR metadata, and decides skip
   rules (drafts / ignored authors).
2. Diff and previous review state are pulled from GitHub.
3. The runner spins up the LLM agent loop with middleware
   (`injectionGuard` → `costGuard` → `main` → `dedup`) and tools
   (`read_file` / `glob` / `grep`) restricted to a partial+sparse clone.
4. Findings are fingerprinted, deduplicated against the previous review,
   gitleaks-scanned, and posted as inline comments + a summary.
5. The hidden state comment is upserted with model, token usage, cost,
   head/base SHAs, and live fingerprints.

## Repo layout

```
packages/
  core/              # types, schemas, fingerprinting (no I/O)
  llm/               # Vercel AI SDK provider adapters + retry/error mapping
  config/            # zod-typed YAML loader, env-merge, JSON schema export
  platform-github/   # VCS impl: clone, diff, comments, hidden state
  runner/            # agent loop, tools, prompts, gitleaks, skill loader
  action/            # GitHub Action wrapper (entry point)
  eval/              # promptfoo regression suite + golden PR fixtures
```

See [`docs/specs/review-agent-spec.md`](./docs/specs/review-agent-spec.md)
for the full specification and [`docs/roadmap.md`](./docs/roadmap.md) for
the milestone plan.

For the per-provider feature parity, eval delta, and cost / latency
trade-offs across the seven supported drivers, see
[`docs/providers/parity-matrix.md`](./docs/providers/parity-matrix.md).

## Status

Maintained as a personal project. Code is published under the
[LICENSE](./LICENSE) for reference and reuse, but external contributions
are not accepted.

- **Pull Requests**: Closed without review. See [CONTRIBUTING.md](./.github/CONTRIBUTING.md).
- **Issues**: Used for internal task tracking only.
- **Forks**: Welcome.

### Versioning

From `v1.0.0` onwards `review-agent` follows
[Semantic Versioning](https://semver.org/). The public API surface,
internal-only surfaces, and per-version migration steps are in
[UPGRADING.md](./UPGRADING.md). Pre-v1.0 (`0.x`) releases are not
SemVer-stable.

## Security

See [SECURITY.md](./SECURITY.md) for the threat model, reporting process,
and the mitigations baked into the runner (sandbox, denylist, gitleaks,
prompt-injection guard, cost cap).

## License

[Apache-2.0](./LICENSE).
