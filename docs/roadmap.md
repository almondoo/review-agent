# Roadmap

Implementation order and dependency map for v0.1 → v1.0. Each row links to a
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

## v1.0 — Stable: API freeze, security audit, full quality bar (9 issues)

| # | Issue | Title (short) | Depends on |
|---|---|---|---|
| 43 | [#43](https://github.com/almondoo/review-agent/issues/43) | docs(repo): UPGRADING.md template + SemVer stability declaration | — |
| 44 | [#44](https://github.com/almondoo/review-agent/issues/44) | security: third-party security audit or equivalent threat-model review | #36, #37 |
| 45 | [#45](https://github.com/almondoo/review-agent/issues/45) | feat(eval): record first measured baseline across all providers | #31, #33 |
| 46 | [#46](https://github.com/almondoo/review-agent/issues/46) | docs(providers): per-provider feature parity matrix | #31, #33, #45 |
| 47 | [#47](https://github.com/almondoo/review-agent/issues/47) | docs(repo): bot identity guidance for Action vs Server modes | — |
| 48 | [#48](https://github.com/almondoo/review-agent/issues/48) | feat(runner,config): multi-bot coordination policy | — |
| 49 | [#49](https://github.com/almondoo/review-agent/issues/49) | docs(repo,platform-github): GHES compatibility statement | — |
| 50 | [#50](https://github.com/almondoo/review-agent/issues/50) | feat(cli): `review-agent setup workspace` (Anthropic ZDR + spend caps) | #23 |
| 51 | [#51](https://github.com/almondoo/review-agent/issues/51) | feat(skills,security): cosign attestation for npm-distributed skills (v1.1 tracking) | #7 |

**Suggested execution order**: 43 → 47 / 49 → 45 → 46 → 48 → 50 → 44 → 51. #51
is a v1.1 tracking ticket and can be closed as wontfix if first-party skill
publication is not undertaken.

**v1.0 acceptance criteria**: see PRD §12.1. Closing all 9 issues plus
re-running typecheck / lint / test / eval / build is the v1.0 release gate.

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
- #11 eval scaffold — `ad3c754`
- #12 docs (README + SECURITY) — `ad3c754`
- #13 self-review CI workflow — `ad3c754`

v0.2 — all 11 issues shipped on `main`:

- #14 platform-github GitHub App auth — `2d3bc34`
- #15 server Hono webhook — `45bb542`
- #16 server SQS + idempotency cleanup — `c0fe860`
- #17 platform-codecommit adapter — `9354788`
- #18 db Drizzle + Postgres schema — `68bd5bd`
- #19 incremental review (rebase + line shift + state mirror) — `2331ad6`
- #20 OTel + Langfuse + body redaction — `91e216d`
- #21 cost ledger + audit HMAC chain — `8d48d9a`
- #22 AWS Lambda + Terraform + deployment docs — `dcc73cc`
- #23 review-agent CLI — `7983256`
- #24 llm OpenAI provider — `3815cea`

v0.3 — all 13 issues shipped on `main`:

- #25 db RLS for multi-tenancy — `c6c82ac`
- #26 per-installation BYOK with KMS envelope encryption — `4ab1eb1`
- #27 org central config repository — `faed42a`
- #28 Helm chart + KEDA autoscaling — `49c2e59`
- #29 GCP Cloud Run + Terraform + deployment docs — `7e8fa44`
- #30 Azure Container Apps + Terraform + deployment docs — `9e228ff`
- #31 full provider matrix (Azure / Google / Vertex / Bedrock / OpenAI-compat) — `20d9414`
- #32 red-team golden fixtures + CI gate — `0033a5b`
- #33 prompt eval harness expanded to 50+ PRs — `1a82354`
- #34 docker-compose self-host example — `413a4a7`
- #35 cost cap enforcement at runtime — `bc0e5f9`
- #36 LLM-based injection detector — `071b3a8`
- #37 incident response runbooks finalized — `774ee4c`
- spec §22 open questions resolved — `849b6df`

v1.0 — all 9 issues (#43–#51) shipped on `main`:

- #43 UPGRADING.md + SemVer stability declaration — `d688f23`
- #44 STRIDE walkthrough + procedure amendment (multi-AI-agent sign-off) — `9dd245e`, `db75cb0`, `71364d9`
- #45 baseline measurement (60-fixture corpus) — `44947f7`
- #46 provider parity matrix — `44947f7`
- #47 bot identity guidance — `9dd245e`
- #48 multi-bot coordination policy — `a2e5628`
- #49 GHES compatibility statement — `9dd245e`
- #50 `review-agent setup workspace` CLI — `0a2bb2c`
- #51 cosign skill attestation (v1.1 tracking, wontfix until first first-party skill) — `9dd245e`

v1.0 follow-on:

- #58 wire gitleaks scanner into agent pipeline (surfaced by Round 1 of #44's review) — `54e4953`

---

## v1.0.1 — hotfix patches for doc-vs-code gaps (2 issues, planning)

Two architectural gaps surfaced by a 2026-05-15 multi-agent code audit
of the v1.0 baseline (issue #44 procedure round 2). Both are
implemented "skeleton only" — the infrastructure ships but is never
wired to the LLM call path. Cut a v1.0.1 hotfix once both land.

| # | Issue | Title (short) | Depends on |
|---|---|---|---|
| 59 | [#59](https://github.com/almondoo/review-agent/issues/59) | feat(llm,runner): expose read_file/glob/grep tools to the LLM | — |
| 60 | [#60](https://github.com/almondoo/review-agent/issues/60) | feat(runner,action): wire incremental diff via sinceSha | — |

**Suggested execution order**: #59 → #60. They are independent
(can be parallelised) but #59 unblocks v1.1's #63 + #70, so prioritise it.

**v1.0.1 release gate**: both #59 and #60 closed, typecheck + lint +
test:coverage + build green, walkthrough rows T-2 / I-2 / E-1 in
`docs/security/threat-model-review-2026-05.md` updated to reflect
the new behaviour.

---

## v1.1 — structured output, ops hardening, Server-mode quality (11 issues, planning)

Eleven enhancements grouped into four themes. All issues have a
"Ready to implement (2026-05-16)" comment with locked design
decisions and concrete acceptance criteria.

### Theme 1 — structured output (3 issues, ship as ONE PR)

| # | Issue | Title (short) | Bundle |
|---|---|---|---|
| 61 | [#61](https://github.com/almondoo/review-agent/issues/61) | explicit severity rubric in BASE_SYSTEM_PROMPT | A |
| 64 | [#64](https://github.com/almondoo/review-agent/issues/64) | add category field to InlineCommentSchema | A |
| 69 | [#69](https://github.com/almondoo/review-agent/issues/69) | add confidence + ruleId to InlineCommentSchema | A |

### Theme 2 — review-event mapping + context expansion (2 issues)

| # | Issue | Title (short) | Depends on |
|---|---|---|---|
| 65 | [#65](https://github.com/almondoo/review-agent/issues/65) | map severity → GitHub review event (REQUEST_CHANGES on critical) | #64 |
| 66 | [#66](https://github.com/almondoo/review-agent/issues/66) | pass commit messages + PR labels + base branch into ReviewInput | — |

### Theme 3 — durability + ops (3 issues)

| # | Issue | Title (short) | Depends on |
|---|---|---|---|
| 62 | [#62](https://github.com/almondoo/review-agent/issues/62) | state-comment write retry + fail-loud | — |
| 67 | [#67](https://github.com/almondoo/review-agent/issues/67) | audit_log + cost_ledger retention + export CLI | — |
| 71 | [#71](https://github.com/almondoo/review-agent/issues/71) | stronger ReviewState validation (Zod refines) | — |

### Theme 4 — quality measurement + Server / path features (3 issues)

| # | Issue | Title (short) | Depends on |
|---|---|---|---|
| 68 | [#68](https://github.com/almondoo/review-agent/issues/68) | severity consistency assertions in red-team + golden fixtures | #61 |
| 63 | [#63](https://github.com/almondoo/review-agent/issues/63) | provision workspace in Server mode (contents-api default) | #59 |
| 70 | [#70](https://github.com/almondoo/review-agent/issues/70) | path_instructions auto-fetch + glob validation | #59 (partial: validation half ships independently) |

**Suggested v1.1 execution order**:

1. **#71** — defensive, low-risk warmup; lands fast.
2. **#62** — same, narrow scope.
3. **#61 + #64 + #69** — Theme 1 bundled PR (largest single change, highest review-quality win).
4. **#65** — depends on #64 (`category`); changes default UX, document in UPGRADING.
5. **#68** — depends on #61 (rubric); locks in baseline for severity consistency.
6. **#66** — independent; PR-metadata expansion.
7. **#67** — independent; retention + export tooling.
8. **#63** — depends on v1.0.1 #59; Server-mode parity.
9. **#70** — depends on v1.0.1 #59; final piece.

**v1.1 release gate**: all 11 issues closed, eval baseline stable
(severity_consistency_score ≥ baseline from #68), typecheck + lint
+ test:coverage + build green.
