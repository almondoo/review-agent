# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in this project, please report it
privately via [GitHub Security Advisories](https://github.com/almondoo/review-agent/security/advisories/new).

Do **not** report security issues through public channels (forks, discussions,
or social media) until they have been addressed. As this is a personal
project, response times are best-effort but you can expect an initial
acknowledgement within a reasonable timeframe.

---

## Threat model

`review-agent` runs untrusted code (the diff being reviewed) through an LLM
that has tool access. We treat the following as untrusted input at all times:

- PR title, body, commit messages, branch name, author display name
- File contents within the diff
- Anything the agent reads via `read_file` / `glob` / `grep`
- Skill content embedded in user-controlled paths

Adversaries can attempt:

1. **Prompt injection** in any of the above to make the agent leak the
   system prompt, exfiltrate secrets, post arbitrary comments, or skip
   the review entirely.
2. **Path traversal** to read files outside the changed paths
   (e.g. `.env`, `.git/config`, `node_modules` lockfiles with tokens).
3. **Symlink attacks** to pivot from a sandboxed clone to host paths.
4. **Cost exhaustion** by inflating diff size, agent loop depth, or tool
   calls.
5. **Secret leakage** in agent reasoning, tool output, or final comments.

## Built-in mitigations

| Threat | Mitigation | Spec ref |
|---|---|---|
| Prompt injection | Untrusted-content wrapper in system prompt; injection-guard middleware; user content never executed as instructions | §6.4, §11 |
| Path traversal | Denylist (`.env*`, `.git/`, `node_modules/`); resolve-and-verify against partial+sparse clone root; symlink refusal | §11.2 |
| Symlinks | `read_file` rejects symlinks; tool calls rooted at the clone dir | §11.2 |
| Cost exhaustion | Per-PR `cost-cap-usd` hard cap; cost-guard middleware short-circuits the loop; tool-call budget per turn | §6.2, §11.1 |
| Secret leakage | `gitleaks` scan on agent text before posting; redaction; review aborts if secrets are present in agent output | §11.3 |
| Container escape | Non-root `agent` user; `REVIEW_AGENT_SANDBOXED=1`; minimal alpine base; no host mounts in the default Action | §15.1 |
| Bot author abuse | `ignore_authors` defaults skip `dependabot[bot]` / `renovate[bot]` / `github-actions[bot]` | §10 |

## Operational guidance

- **Scope `GITHUB_TOKEN`**: the workflow only needs `pull-requests: write` and
  `contents: read`. Don't grant `actions: write` or repo admin.
- **Pin the Action by tag**: use `almondoo/review-agent@v0.1.0` in production,
  not `@main`.
- **Use repository secrets, not env vars**: `ANTHROPIC_API_KEY` must come
  from `secrets.*`, never from PR-controlled inputs.
- **Set a cost cap**: `cost-cap-usd` is a hard ceiling, not a target.
  Default is `1.0`; lower for high-PR-volume repos.
- **Self-host runners cautiously**: the default GitHub-hosted runner is the
  recommended sandbox boundary. Self-hosted runners must enforce ephemeral
  VMs.

## Out of scope

- Attacks against the GitHub Actions runner platform itself.
- LLM provider availability and pricing changes.
- Bugs in user-supplied skills or `path_instructions`.

If in doubt, file a Security Advisory rather than guessing scope.
