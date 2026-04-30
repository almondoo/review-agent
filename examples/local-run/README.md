# Local run

Run `review-agent` locally against a real GitHub PR using Docker Compose.
The action is a one-shot: it pulls the PR, runs the review, posts comments,
and exits.

## Prerequisites

- Docker / Docker Compose
- A GitHub token with `pull-requests: write` on the target repo
- An Anthropic API key

## Setup

```bash
cp .env.example .env
# fill GITHUB_TOKEN, ANTHROPIC_API_KEY, GITHUB_REPOSITORY (owner/repo)

cp examples/local-run/event.example.json examples/local-run/event.json
# edit event.json: set pull_request.number to the PR you want to review,
# and repository.owner.login + repository.name to match GITHUB_REPOSITORY
```

Optionally drop a `.review-agent.yml` at the repo root to override
language, profile, ignore_authors, etc. The compose file mounts it
read-only at `/app/.review-agent.yml`.

## Run

```bash
docker compose up --build review-agent
```

The container exits after one review. Re-run with the same command to
review again (incremental: existing inline comments are deduplicated via
the hidden state comment).

## Logs

Anthropic cost and posted-comment counts are emitted to stdout via
`@actions/core` (`Posted N comments. Cost: $X.XXXX.`). The action sets
non-zero exit on hard failures (auth, schema, cost cap exceeded).

## Notes

- The container does not contain your repo's source. The runner's
  `read_file`/`glob`/`grep` tools operate on a partial+sparse clone the
  action performs at startup, so only changed paths are pulled.
- `gitleaks` is baked into the image.
- The agent runs as a non-root `agent` user inside the container.
- To pin a different model, set `provider.model` in `.review-agent.yml`.
