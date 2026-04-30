# Roadmap

Implementation order and dependency map for v0.1 → v0.3. Each row links to a
GitHub Issue. Pick up the next unblocked issue in version order.

The full implementation specification is at
[`docs/specs/review-agent-spec.md`](./specs/review-agent-spec.md). Issue bodies
reference its sections (e.g. §5.2, §7.7, §12.3, §21.1).

Live state on GitHub:

```
gh issue list --repo almondoo/review-agent --milestone v0.1 --state open
gh issue list --repo almondoo/review-agent --milestone v0.2 --state open
gh issue list --repo almondoo/review-agent --milestone v0.3 --state open
gh issue view <N> --repo almondoo/review-agent
```

---

## v0.1 — GitHub Action, OSS-public quality (13 issues)

| # | Issue | Title (short) | Depends on |
|---|---|---|---|
| 1 | [#1](https://github.com/almondoo/review-agent/issues/1) | feat(core): interfaces and types | — (bootstrap) |
| 2 | [#2](https://github.com/almondoo/review-agent/issues/2) | feat(platform-github): adapter (Octokit + PAT) | #1 |
| 3 | [#3](https://github.com/almondoo/review-agent/issues/3) | feat(llm): LlmProvider + anthropic driver (Vercel AI SDK) | #1 |
| 4 | [#4](https://github.com/almondoo/review-agent/issues/4) | feat(runner): provider-agnostic agent loop + middleware + tools | #1, #3 |
| 5 | [#5](https://github.com/almondoo/review-agent/issues/5) | feat(action): GitHub Action wrapper (action.yml + bundled JS) | #2, #4 |
| 6 | [#6](https://github.com/almondoo/review-agent/issues/6) | feat(config): `.review-agent.yml` v1 schema + JSON Schema | #1, #3 |
| 7 | [#7](https://github.com/almondoo/review-agent/issues/7) | feat(runner): skill loader | #4, #6 |
| 8 | [#8](https://github.com/almondoo/review-agent/issues/8) | feat(runner): gitleaks integration (diff + file-read scan) | #4 |
| 9 | [#9](https://github.com/almondoo/review-agent/issues/9) | feat(runner): hidden state comment + fingerprint dedup (incremental v0) | #1, #2, #4 |
| 10 | [#10](https://github.com/almondoo/review-agent/issues/10) | feat(infra): sandbox baseline (whitelist + Docker + deny list) | #4 |
| 11 | [#11](https://github.com/almondoo/review-agent/issues/11) | feat(eval): golden PR set (30 PRs) + promptfoo CI | #3, #4 |
| 12 | [#12](https://github.com/almondoo/review-agent/issues/12) | docs(repo): README + SECURITY.md + basic docs site | — |
| 13 | [#13](https://github.com/almondoo/review-agent/issues/13) | feat(infra): self-review CI workflow on this repo | #5, #11 |

**Suggested execution order**: 1 → 3 → 2 → 4 → 6 → 8 → 10 → 9 → 7 → 5 → 11 → 13. Issue #12 (docs) can run in parallel anytime.

**Open questions blocking v0.1**: see [tracking issue](https://github.com/almondoo/review-agent/issues?q=label%3Aquestion+is%3Aopen) (label `question`) — Q1 blocks #7, Q2 and Q3 block #6.

---

## v0.2 — Server, GitHub App, CodeCommit, AWS deploy (11 issues)

| # | Issue | Title (short) | Depends on |
|---|---|---|---|
| 14 | [#14](https://github.com/almondoo/review-agent/issues/14) | feat(platform-github): GitHub App auth (`@octokit/auth-app`) | #2 |
| 15 | [#15](https://github.com/almondoo/review-agent/issues/15) | feat(server): Hono webhook server (Lambda + Node) | #14 |
| 16 | [#16](https://github.com/almondoo/review-agent/issues/16) | feat(server): SQS receive/dispatch + idempotency table | #15, #18 |
| 17 | [#17](https://github.com/almondoo/review-agent/issues/17) | feat(platform-codecommit): adapter via `@aws-sdk/client-codecommit` | #1 |
| 18 | [#18](https://github.com/almondoo/review-agent/issues/18) | feat(db): Drizzle + Postgres schema + migrations | #1 |
| 19 | [#19](https://github.com/almondoo/review-agent/issues/19) | feat(core): full incremental review (rebase detection + line shifting) | #9, #18 |
| 20 | [#20](https://github.com/almondoo/review-agent/issues/20) | feat(observability): OTel + Langfuse | #4 |
| 21 | [#21](https://github.com/almondoo/review-agent/issues/21) | feat(db): cost ledger + audit log (HMAC chain) | #18 |
| 22 | [#22](https://github.com/almondoo/review-agent/issues/22) | feat(infra): AWS Lambda + Terraform + `docs/deployment/aws.md` | #15, #16 |
| 23 | [#23](https://github.com/almondoo/review-agent/issues/23) | feat(cli): `review-agent` CLI | #2, #4, #6 |
| 24 | [#24](https://github.com/almondoo/review-agent/issues/24) | feat(llm): OpenAI provider driver | #3 |

---

## v0.3 — Multi-tenant production (13 issues)

| # | Issue | Title (short) | Depends on |
|---|---|---|---|
| 25 | [#25](https://github.com/almondoo/review-agent/issues/25) | feat(db): Postgres RLS for multi-tenancy | #18 |
| 26 | [#26](https://github.com/almondoo/review-agent/issues/26) | feat(security): per-installation BYOK with KMS envelope encryption | #18 |
| 27 | [#27](https://github.com/almondoo/review-agent/issues/27) | feat(config): org central config repository | #6 |
| 28 | [#28](https://github.com/almondoo/review-agent/issues/28) | feat(infra): Helm chart + KEDA autoscaling | #15 |
| 29 | [#29](https://github.com/almondoo/review-agent/issues/29) | feat(infra): GCP Cloud Run + Terraform + `docs/deployment/gcp.md` | #15 |
| 30 | [#30](https://github.com/almondoo/review-agent/issues/30) | feat(infra): Azure Container Apps + Terraform + `docs/deployment/azure.md` | #15 |
| 31 | [#31](https://github.com/almondoo/review-agent/issues/31) | feat(llm): full provider matrix (Azure / Google / Vertex / Bedrock / OpenAI-compat) | #3, #24 |
| 32 | [#32](https://github.com/almondoo/review-agent/issues/32) | feat(eval): red-team golden fixtures + CI gate | #11 |
| 33 | [#33](https://github.com/almondoo/review-agent/issues/33) | feat(eval): prompt eval harness expanded to 50+ PRs | #11 |
| 34 | [#34](https://github.com/almondoo/review-agent/issues/34) | feat(infra): docker-compose example | #15, #18 |
| 35 | [#35](https://github.com/almondoo/review-agent/issues/35) | feat(runner): cost cap enforcement at runtime | #4, #21 |
| 36 | [#36](https://github.com/almondoo/review-agent/issues/36) | feat(runner): LLM-based injection detector | #4 |
| 37 | [#37](https://github.com/almondoo/review-agent/issues/37) | docs(security): incident response runbooks finalized | #12 |

---

## Status

v0.1 — all 13 issues shipped on `main`:

- #1 core interfaces — `e681bf4` (realigned to spec in `eeb151a`)
- #2 platform-github — `c916200`
- #3 llm provider — `e7f3174`
- #4 runner agent loop — `6377814`
- #5 action wrapper — `fe87e5c`
- #6 config schema — `c58d8b9`
- #7 skill loader — `ef71cf6`
- #8 gitleaks integration — `47bb848`
- #9 hidden state + dedup — `47bb848`
- #10 sandbox baseline — `fe87e5c`
- #11 eval scaffold — pending commit
- #12 docs (README + SECURITY) — pending commit
- #13 self-review CI workflow — pending commit

v0.2 / v0.3: open, not started.
