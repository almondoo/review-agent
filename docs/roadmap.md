# Roadmap

**SSOT for wave / issue state.** This file is the single source of truth for:

- どの wave がどこにシップ済か (`main` / `develop` / open PR)
- どの issue がアクティブで何にブロックされているか
- operator-runtime のみで完結する待機タスク (API key / DB 接続が要るもの)

CLAUDE.md / `.changeset/*` / GitHub issue body はここを参照する。逆方向にしない。

---

## Current state (as of 2026-06-04)

| 観点 | 状態 |
|---|---|
| Latest wave on `main` | **post-v1.2 waves A–C** — PR [#133](https://github.com/almondoo/review-agent/pull/133) merged 2026-06-04（GitHub App dashboard onboarding + dashboard SPA + eval/feedback hardening、#123〜#131 を main へ）。直前は v1.0.1+v1.1+v1.2（PR [#94](https://github.com/almondoo/review-agent/pull/94), 2026-05-18, `Closes #83〜#93`）|
| Latest wave on `develop` | **config-as-code & quality wave（進行中、2026-06-04〜）** — landed: #143 eval gate / #139 OSS governance / #147 BYOK doc / #146 config resolution+provenance / #148 ruleset。実装中/予定: #156→#159→#151→#145（config chain）+ #155/#157/#149（runner/platform）。直前は #132 interim IDOR interlock（`REVIEW_AGENT_MULTI_TENANT` fail-closed guard + GA 設計文書）|
| post-v1.2 follow-on (#95–#110) | **全 close 済み** — recover-sync-state(#105) / fail-open OTel metrics(#106) / docs(#98/#100/#103) / test(#107/#108) / baseline(#97) / parity(#102) / CodeCommit feedback re-scrape(#110) すべて shipped・closed |
| Active GA tracking | **#132** (per-installation IDOR hardening) — interim fail-closed interlock + GA 設計文書を develop に landed。**フル per-principal authz（AC#1/#2）は GA 据え置き**（認証モデル決定待ち）で #132 は GA tracking ticket として open 継続。#161 (dashboard RBAC) は #132 の認証モデルに依存 |
| 次wave候補 (open, 未refined) | **#134–#160 / #162** — richer PR summary / local trial / audit log / SSO / cost analytics / quality metrics / notifications / presets / platform 拡張(GitLab/GHES) 等の大型 epic 群。多くは spec 沈黙で製品/UX 判断 (spec §22) を要する。#136/#137/#138/#140/#144/#154 は外部リソース・他issue依存でブロック |

Live state は GitHub の検索で確認:

```
gh issue list --repo almondoo/review-agent --state open
gh issue view <N> --repo almondoo/review-agent
gh pr view 94 --repo almondoo/review-agent
```

The full implementation specification is at
[`docs/specs/review-agent-spec.md`](./specs/review-agent-spec.md). Issue bodies
reference its sections (e.g. §5.2, §7.7, §12.3, §21.1).

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

v1.0.1 — both issues shipped on `develop`:

- #59 expose read_file/glob/grep tools to the LLM — `d20f101`
- #60 wire incremental diff via sinceSha — `e3281cd`

v1.1 — all 11 issues (#61–#71) shipped on `develop`:

- #61 explicit severity rubric + what-NOT-to-flag + suggestion guidance — `6498bb3`
- #62 state-comment retry + fail-loud — `615fa8a`
- #63 provision workspace in Server mode — `62ae130` (+ `15ac9c3` reviewer I-1 denylist parity)
- #64 add optional category field to InlineCommentSchema — `9e3f3ba`
- #65 map severity to GitHub review event — `5c76b93`
- #66 surface commit messages + labels + base branch to LLM — `6844725` (+ `215abed` reviewer I-1 listCommits perf)
- #67 audit_log + cost_ledger retention + export CLI — `198fba3` (+ `bfcd769` reviewer I-1/I-2 retention.md RLS doc)
- #68 severity consistency assertions + CI gate — `a534c37`
- #69 add confidence + ruleId to InlineCommentSchema — `553f156`
- #70 path_instructions auto-fetch + glob validation — `011d014` (+ `ffe6aa6` reviewer I-1 `<related_files>` envelope)
- #71 stronger ReviewState validation via Zod schema — `6ef4ff2`

17 commits (13 features + 4 reviewer-fix follow-ups) landed on `develop`
between 2026-05-16 and 2026-05-16 in a single multi-agent wave. Final
regression: 823/823 unit tests, typecheck/lint/build green across all
12 packages. Not yet merged to `main`.

---

## v1.0.1 — hotfix patches for doc-vs-code gaps (2 issues, shipped on `develop`)

Two architectural gaps surfaced by a 2026-05-15 multi-agent code audit
of the v1.0 baseline (issue #44 procedure round 2). Both were
implemented "skeleton only" in v1.0 — the infrastructure shipped but
was never wired to the LLM call path. Both are now wired on `develop`.

| # | Issue | Title (short) | Commit |
|---|---|---|---|
| 59 | [#59](https://github.com/almondoo/review-agent/issues/59) | feat(llm,runner): expose read_file/glob/grep tools to the LLM | `d20f101` |
| 60 | [#60](https://github.com/almondoo/review-agent/issues/60) | feat(runner,action): wire incremental diff via sinceSha | `e3281cd` |

**Execution order taken**: #59 → #60 (as suggested; #59 unblocked v1.1's
#63 + #70). A retry-undercount fix on #59 (use `Math.max` instead of a
ternary so cumulative tool-call counts survive the schema-retry path)
landed transparently inside `553f156` (#69 commit) due to in-flight
working-tree overlap; net effect on develop is correct.

---

## v1.1 — structured output, ops hardening, Server-mode quality (11 issues, shipped on `develop`)

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

**Execution order taken** (multi-agent wave on `develop`, 2026-05-16):

1. **#71** — `6ef4ff2`, ReviewState Zod refines + StateParseEvent.
2. **#59** (v1.0.1) — `d20f101`, LLM tool exposure.
3. **#64** — `9e3f3ba`, InlineCommentSchema.category.
4. **#67** — `198fba3` + `bfcd769` doc fix, audit retention + export CLI.
5. **#60** (v1.0.1) — `e3281cd`, incremental diff via sinceSha.
6. **#69** — `553f156`, confidence + ruleId + min_confidence filter.
7. **#68** — `a534c37`, severity-consistency eval + CI gate.
8. **#61** — `6498bb3`, severity rubric + what-NOT + suggestion guidance.
9. **#66** — `6844725` + `215abed` perf fix, commits/labels/base_branch surface.
10. **#62** — `615fa8a`, state-comment retry + state-write-retries input.
11. **#65** — `5c76b93`, severity → REQUEST_CHANGES mapping + branch-protection guidance in SECURITY.md.
12. **#63** — `62ae130` + `15ac9c3` denylist parity, Server-mode workspace provisioning.
13. **#70** — `011d014` + `ffe6aa6` envelope fix, path_instructions auto-fetch + glob validation.

**v1.1 release gate**: all 11 issues closed ✓ (on `develop`), typecheck +
lint + test:coverage + build green ✓ (823/823 unit tests pass at HEAD
`ffe6aa6`). Eval baseline measurement (`severity_consistency_score`)
remains null in `packages/eval/baseline.json` — the gate is dormant until
the promptfoo→scoring-input shim lands as a wave-end follow-up.

---

## v1.2 — continuous review evaluation & improvement loop (epic #83, 4 phases)

Epic [#83](https://github.com/almondoo/review-agent/issues/83) defines a
closed loop: review → measure → learn → improved review. The four phases
were split into child issues on 2026-05-18 with locked design decisions
from the epic body's "Open questions" section.

| Phase | Issue | Title (short) | Main packages |
|---|---|---|---|
| 1 | [#90](https://github.com/almondoo/review-agent/issues/90) | eval: baseline.json measurement + severity-consistency CI gate enablement | `packages/eval/`, `.github/workflows/eval.yml` |
| 2 | [#91](https://github.com/almondoo/review-agent/issues/91) | runner,core,db: per-review metrics middleware + review_eval_event table + latency | `packages/runner/middleware/`, `packages/core/db/schema/` |
| 3 | [#92](https://github.com/almondoo/review-agent/issues/92) | platform-github,server,runner: feedback signal collection + review_history writer | `packages/platform-github/`, `packages/server/handlers/`, `packages/runner/` |
| 4 | [#93](https://github.com/almondoo/review-agent/issues/93) | runner: composeSystemPrompt <learned_facts> injection + feedback-aware dedup | `packages/runner/prompts/`, `packages/runner/middleware/dedup.ts` |

**Suggested execution order**: Phase 2 first (observability blocks
effect measurement) → Phase 1 and Phase 3 in parallel → Phase 4 after
Phase 3 ships the writer side.

**Locked design decisions** (from epic Open questions):

- Q1 — new `review_eval_event` table over `cost_ledger` extension (per-review vs per-call granularity).
- Q2 — comment-reply LLM interpretation deferred; Phase 3 uses explicit signals only (👍 / 👎 / dismiss).
- Q3 — `accepted_pattern` triggered by 👍 only; pattern (b) and (c) deferred.
- Q4 — Anthropic Sonnet (`claude-sonnet-4-6`) for the first baseline measurement; multi-provider parity handled separately via #46.
- Q5 — `<learned_facts>` injection capped at 50 entries per spec §7.6.

**v1.2 release gate**: all 4 phase issues closed + spec §7.6 "writer /
reader 未実装" notation updated. `pnpm typecheck && pnpm lint &&
pnpm test:coverage && pnpm build` green at the wave-end commit.

### v1.2 wave — landed on `develop` (2026-05-18 〜 19)

Coding AC は全て完了。`Closes #83〜#93` で PR #94 から main へ送出予定。
1221 unit tests pass + 7 skipped (DB integration、`TEST_DATABASE_APP_URL` で
unlock)。typecheck / lint / build green。

- #83 (epic) — 子 #90/#91/#92/#93 + roadmap v1.2 section / spec §7.6.1 更新 — `dbec488`
- #84 — audit Section A: dead `shiftLineThroughHunks` 削除 — `d1c100e`
- #85 — privacy.allowed_url_prefixes URL allowlist refine — `9466d30` 他
- #86 — privacy.deny_paths in read_file/glob/grep — `1fc1799` 他
- #87 — privacy.redact_patterns alongside gitleaks — `3dec688` 他
- #88 — reviews.{path_filters,max_files,max_diff_lines} — `1b60fe9` 他
- #89 — repo.{submodules,lfs} cloneHints → CloneOpts — `7548fca`
- #90 (Phase 1) — promptfoo→scoring shim + baseline-measure CLI + E2E gate test — `5bc7861`, `14c92e0`
- #91 (Phase 2) — review_eval_event テーブル + EvalMiddleware + cost_ledger.latency_ms — `f03f4e5`, `14c92e0`
- #92 (Phase 3) — feedback writer (PII redact + 10/job rate-limit + `[fp:…]` prefix) + webhook reaction/dismiss recognition + startReviewHistoryCleanup — `aee4209`, `4b99a1b`, `14c92e0`
- #93 (Phase 4) — `<learned_facts>` injection + feedback-aware dedup + droppedByFeedback — `bff75ce`
- 統合 test (v1.2 wave) — RLS / TTL integration test + reactions/dismissed helpers — `445d8c6`, `4b99a1b`

---

## post-v1.2 wave A — Refined 4 件、`main` マージ済み via #133 (landed 2026-05-19)

| # | Issue | Title (short) | Merge commit |
|---|---|---|---|
| 95 | [#95](https://github.com/almondoo/review-agent/issues/95) | CodeCommit `/feedback` コマンド (fp_prefix 経路のみ、marker は #96 後送り stub) | `03e8230` |
| 99 | [#99](https://github.com/almondoo/review-agent/issues/99) | `review-agent feedback backfill` CLI + writer `maxWritesPerJob: 'unlimited'` | `6bf43c5` |
| 101 | [#101](https://github.com/almondoo/review-agent/issues/101) | LLM-as-a-Judge auto-grader + judge prompt v1 + informational CI step | `b8d82d4` |
| 104 | [#104](https://github.com/almondoo/review-agent/issues/104) | SLO / dashboard playbook (`docs/operations/slo-playbook.md`) | `f8817e9` |

**Wave 検証**: typecheck / lint / build green、unit tests 1351 passed + 7 skipped
(DB integration、`TEST_DATABASE_APP_URL` で unlock)。`main` への送出は別 PR で。

**#95 の補足**: fingerprint 解決は (b) 経路 `<fp_prefix>` 引数明示のみ。
`extractFingerprintMarker(body)` は実装済 + テスト済の helper として残してあり、
#96 (Bot コメントに `<!-- fingerprint:<fp> -->` を埋め込む) が landed すると
コード変更なしで (a) 経路が有効化される。

---

## post-v1.2 follow-on wave (#95–#131 closed; #132 interim landed) — 履歴

> **このセクションは履歴（shipped 記録）です。** 以下の実装/docs/test/operator
> issue (#95–#110, #118–#131) は **すべて close 済み**。#132 は interim interlock を
> develop に landed したが GA tracking として **open 継続**。アクティブな未着手作業
> ではない（2026-06-04 時点で `gh issue list --state open` に現れるのは #132 と
> #134–#162 のみ）。新規の未着手バックログは末尾の「## Open backlog」を参照。

### 実装系（closed）

| # | タイトル | 状態 |
|---|---|---|
| [#105](https://github.com/almondoo/review-agent/issues/105) | recover-sync-state v1.2 mirror reconciliation (CodeCommit) | ✅ closed |
| [#106](https://github.com/almondoo/review-agent/issues/106) | OTel metrics for fail-open events | ✅ closed |
| [#110](https://github.com/almondoo/review-agent/issues/110) | CodeCommit `recover feedback-history` re-scrape (#105 から分割) | ✅ closed |
| _(unfiled)_ | CodeCommit web embedded auto-setup + server worker JobHandler — spec: [`codecommit-web-embedded-auto-setup.md`](./specs/codecommit-web-embedded-auto-setup.md) / handoff: [`session-handoff-2026-05-29-dashboard.md`](./specs/session-handoff-2026-05-29-dashboard.md) — 13–14 person-days (B0 blocker = JobHandler) — **未起票・将来検討** | n/a |

### Dashboard / web UI (2026-06-01 追加)

`packages/web` ダッシュボード SPA の UX / i18n / セキュリティ。要件は maintainer
提示、spec は §2.2 (言語) / §8.5 (BYOK) / §16.1 (RLS) を参照。

| # | タイトル | Refined |
|---|---|---|
| [#118](https://github.com/almondoo/review-agent/issues/118) | dashboard i18n (ja/en, 既定 ja) via react-i18next | ✅ landed (develop) |
| [#119](https://github.com/almondoo/review-agent/issues/119) | 未保存変更の離脱確認 (全 dirty フォーム, `useBlocker`) | ✅ landed (develop) |
| [#120](https://github.com/almondoo/review-agent/issues/120) | 削除確認の共通 ConfirmDialog 化 (土台) | ✅ landed (develop) |
| [#121](https://github.com/almondoo/review-agent/issues/121) | BYOK LLM API キー登録ページ + KMS 暗号化書込 API | ✅ landed (develop, operator 単一テナント認可) |

**実装順序**: `#120 (ConfirmDialog) ──► #119 / #121`、`#118` は独立並行。
`#121` の Open question (認可モデル) は **operator 単一テナント前提**で解決 (spec §22) し landed。

#### post-v1.2 wave B — dashboard UX、`main` マージ済み via #133 (landed 2026-06-02)

#118 / #119 / #120 / #121 を多エージェント wave で landed。`main` へは PR #133 でマージ済み (2026-06-04)。
#121 の認可 Open question は **operator 単一テナント前提**で解決 (spec §22)。

| # | Title (short) | 主な変更 |
|---|---|---|
| 118 | dashboard i18n (ja 既定) | `react-i18next` + `i18n/{ja,en}.json` (ja default+fallback) + header 言語切替 + navigator/localStorage 検出 + `<html lang>` + 全 user-facing 文字列外部化 |
| 119 | 未保存変更の離脱確認 | `createBrowserRouter` 移行 (`useBlocker` 有効化) + `useUnsavedChangesPrompt` hook (SPA navigation guard + `beforeunload` 二重ガード) + `repos-new` dirty 検知 |
| 120 | 共通 ConfirmDialog | `confirm-dialog.tsx` (portal / focus trap / Esc / backdrop / ARIA)、`repos` / `repo-detail` の delete を集約、`UnsavedChangesDialog` で #119 と共用 |
| 121 | BYOK APIキー登録 | `/api/integrations/llm-keys` (GET/POST/rotate/DELETE)、byok-store(KMS envelope) を per-request の `withTenant(tx)` にバインド (RLS)、`createAuditAppender`、operator 単一テナント認可、平文非返却・非ログ、Zod 検証/監査、web `/integrations/keys` ページ (password 入力・rotate/remove は ConfirmDialog・未保存ガード) |

**Wave 検証**: typecheck / lint / build green、unit 2004 passed + 13 skipped
(DB integration、`TEST_DATABASE_APP_URL` で unlock)。coverage 全閾値クリア
(`packages/web` branches 82.58% ≥ 75%、`packages/server` 90.39% ≥ 90%)。
`main` へは PR #133 でマージ済み (2026-06-04)。

**#121 レビュー修正**: 並列レビューで「`withTenant` の tx が無視され byok-store が
プール接続で実行 → RLS 不発 (listProviders 空・remove 無効・upsert/rotate 500)」の
Critical を検出。byok-store を per-request の tenant tx にバインドして修正、実 tx 経路の
回帰テストを追加。**将来課題**: per-installation 認可 (所有権マッピング) は別 issue、
`VITE_*` ダッシュボードトークンの bundle 露出は全 mutation 共通の既存事項 (要 deployment ガード)。

#### post-v1.2 wave C — GitHub App onboarding、`main` マージ済み via #133 (2026-06-04)

#123〜#131 を多エージェント wave で landed。`main` へは PR #133 でマージ済み (2026-06-04)。全 9 issue 完了（#124〜#131 はマージ後に手動 close）。

| # | Title (short) | 主な変更 |
|---|---|---|
| 123 | github_installations + repos.installation_id + migrations | `github_installations` テーブル + `repos.installation_id` FK + migrations 0006–0008 (RLS tenant_isolation) |
| 124 | listInstallationRepos + App JWT mint | `platform-github` listInstallationRepos + `AppAuthClient.createAppJwt` |
| 125 | GitHub App setup callback + install-redirect | server GET /github/install-redirect + GET /github/setup (CSRF state cookie、redirect-only error handling、`withTenant` upsert) |
| 126 | webhook installation イベント永続化 | installation イベント (created/suspend/unsuspend/deleted) の永続化 |
| 127 | accessible repos API + POST /api/repos/bulk | GET /api/github/installations/:id/repos + POST /api/repos/bulk (201/200/207) |
| 128 | integrations に appSlug + installationCount 実カウント | integrations レスポンスに appSlug + 実 installationCount |
| 129 | GitHub オンボーディング types + hooks + mocks | web API types + hooks + mocks (`useInstallationRepos` / `useBulkCreateRepos`) |
| 130 | /integrations Connect GitHub ボタン + エラーバナー | `/integrations` Connect GitHub ボタン + setup error バナー |
| 131 | /integrations/github/repos repo 選択ページ | `/integrations/github/repos` repo 選択ページ |

**Wave 検証**: typecheck / lint / build green、unit 2,101 passed + 13 skipped
(DB integration、`TEST_DATABASE_APP_URL` で unlock)。coverage 全閾値クリア (13 packages)。
`main` へは PR #133 でマージ済み (2026-06-04)。merge 時に Closes 漏れのため #124〜#131 は手動 close。

### GitHub App オンボーディング — post-v1.2 wave C、`main` マージ済み via #133 (2026-06-04)

Web ダッシュボードから GitHub App をインストールし、リポジトリを一括登録できる
フルオンボーディングフロー。BE-0〜BE-5（server/db）と FE-A〜FE-C（web）の 9 issue、
すべて 2026-06-04 に landed。

| 識別子 | Issue | タイトル (短縮) | 主な変更 |
|---|---|---|---|
| BE-0 | [#123](https://github.com/almondoo/review-agent/issues/123) | github_installations + repos.installation_id + migrations | `github_installations` テーブル + `repos.installation_id` FK + migrations 0006–0008 (RLS tenant_isolation) |
| BE-1 | [#124](https://github.com/almondoo/review-agent/issues/124) | listInstallationRepos + App JWT mint | `platform-github` listInstallationRepos + `AppAuthClient.createAppJwt` |
| BE-2 | [#125](https://github.com/almondoo/review-agent/issues/125) | GitHub App setup callback + install-redirect | `server` GET /github/install-redirect + GET /github/setup (CSRF state cookie、redirect-only error handling、`withTenant` upsert) |
| BE-3 | [#126](https://github.com/almondoo/review-agent/issues/126) | webhook installation イベント永続化 | installation イベント (created/suspend/unsuspend/deleted) の永続化 |
| BE-4 | [#127](https://github.com/almondoo/review-agent/issues/127) | accessible repos API + POST /api/repos/bulk | GET /api/github/installations/:id/repos + POST /api/repos/bulk (201/200/207) |
| BE-5 | [#128](https://github.com/almondoo/review-agent/issues/128) | integrations に appSlug + installationCount 実カウント | integrations レスポンスに appSlug + 実 installationCount |
| FE-A | [#129](https://github.com/almondoo/review-agent/issues/129) | GitHub オンボーディング types + hooks + mocks | web API types + hooks + mocks (`useInstallationRepos` / `useBulkCreateRepos`) |
| FE-B | [#130](https://github.com/almondoo/review-agent/issues/130) | /integrations に Connect GitHub ボタン + エラーバナー | `/integrations` Connect GitHub ボタン + setup error バナー |
| FE-C | [#131](https://github.com/almondoo/review-agent/issues/131) | /integrations/github/repos repo 選択ページ | `/integrations/github/repos` repo 選択ページ |

**Wave 検証**: typecheck / lint / build green、unit 2,101 passed + 13 skipped
(DB integration、`TEST_DATABASE_APP_URL` で unlock)。coverage 全閾値クリア (13 packages)。
`main` へは PR #133 でマージ済み (2026-06-04)。merge 時に Closes 漏れのため #124〜#131 は手動 close。

新規 env: `GITHUB_APP_SLUG`, `REVIEW_AGENT_DASHBOARD_ORIGIN`。
新規 migration: 0006 (github_installations), 0007 (repos.installation_id), 0008 (RLS tenant_isolation)。

### #132 — per-installation IDOR interim interlock（develop に landed、2026-06-04）

#127 で導入した `installationId` 入力系 `/api` エンドポイント（#127 の 2 本 + `llm-keys` 4 本）の
IDOR を、multi-tenant 認証モデル決定前に **構造的に塞ぐ** fail-closed インターロック。
maintainer 承認の **Option A**（fail-closed guard + GA 設計文書）として実装。

- 新規 env **`REVIEW_AGENT_MULTI_TENANT`**（既定 `false`）。`false` ⇒ 現状の単一オペレーター挙動を不変維持。
- 新規 middleware `multiTenantGuard`（`packages/server/src/api/middleware/multi-tenant-guard.ts`）:
  flag が `true` のとき、6 エンドポイント（`GET /api/github/installations/:id/repos`,
  `POST /api/repos/bulk`, `GET|POST|POST /rotate|DELETE /api/integrations/llm-keys`）を
  **token mint / DB 書込の前に HTTP 501 で fail-closed**。誤って multi-tenant に切替えても IDOR が ship しない。
- `/github/setup`・`/github/install-redirect`（CSRF state cookie 束縛）と webhook（HMAC 検証）は対象外（設計上）。
- GA 本実装の設計は **`docs/security/multi-tenant-authz.md`**（per-principal credential は spec §22 の open decision、
  `operator_principals`+`installation_memberships` スキーマ素案、`installationId ∈ callerInstallations` を
  mint/withTenant の前に検査し 403/404 を返す authz middleware）。
- #132 の AC#1/#2（フル per-principal authz）は **GA 据え置き**、AC#4（他エンドポイント横展開）は完了。
  #132 は **GA tracking ticket として open のまま**（close すると GA 義務が消えるため）。
- 検証: repo-root typecheck / lint / test:coverage / build green、server branches 90.05% (≥90%)、guard 100% 被覆。

新規 env: `REVIEW_AGENT_MULTI_TENANT`。

### Docs / Test / Operator runtime（すべて closed）

| # | タイトル | 状態 |
|---|---|---|
| [#98](https://github.com/almondoo/review-agent/issues/98) | worked-example Server-mode worker handler | ✅ closed |
| [#100](https://github.com/almondoo/review-agent/issues/100) | v1.1 → v1.2 migration guide | ✅ closed |
| [#103](https://github.com/almondoo/review-agent/issues/103) | review_eval_event SQL playbook | ✅ closed |
| [#107](https://github.com/almondoo/review-agent/issues/107) | migration rollback / forward-compat regression suite | ✅ closed |
| [#108](https://github.com/almondoo/review-agent/issues/108) | self-feedback loop end-to-end integration test | ✅ closed |
| [#97](https://github.com/almondoo/review-agent/issues/97) | first baseline measurement (Anthropic Sonnet) | ✅ closed |
| [#102](https://github.com/almondoo/review-agent/issues/102) | populate parity.json (8 プロバイダ) | ✅ closed |

上記の依存・実装順序（#107→#100、#108→#107、#97→CI gate enforcing、#102→#97）は
すべて消化済み。詳細は各 issue の close コメント参照。

---

## Open backlog — next-wave candidates（open, 2026-06-04 時点）

`gh issue list --state open` の実態。post-v1.2 follow-on は全 close したため、
現在の未着手 open issue は **#132（GA tracking）と #134–#162** のみ。多くは
roadmap 上「次 wave 候補」で未 refined の大型 epic。spec 沈黙のため製品/UX 判断
(spec §22) を要するものは [B]、外部リソース/他issue依存でブロックされるものは [C]。

### [A] 自律実装着手中（config-as-code & quality wave, develop）

本セッションで着手。AC 明確・spec 参照あり・合理的デフォルトで進行可能なもの。

| # | タイトル | 状態 |
|---|---|---|
| [#143](https://github.com/almondoo/review-agent/issues/143) | review-quality regression eval gate | ✅ landed (develop) |
| [#139](https://github.com/almondoo/review-agent/issues/139) | OSS governance files (LICENSE/CoC/CHANGELOG/release-process) | ✅ landed (develop) |
| [#147](https://github.com/almondoo/review-agent/issues/147) | BYOK key storage model & leak/incident runbook | ✅ landed (develop) |
| [#146](https://github.com/almondoo/review-agent/issues/146) | config-as-code resolution + per-run provenance log | ✅ landed (develop) |
| [#148](https://github.com/almondoo/review-agent/issues/148) | ruleset block (enable/min_severity per category) | ✅ landed (develop) |
| [#156](https://github.com/almondoo/review-agent/issues/156) | externalize pipeline settings (max_steps 等) | 🔄 実装中 |
| [#159](https://github.com/almondoo/review-agent/issues/159) | JSON Schema + `config validate` + editor completion | ⏳ 予定 (#148+#156 後) |
| [#151](https://github.com/almondoo/review-agent/issues/151) | presets with `extends` + bundled first-party presets | ⏳ 予定 (#148+#159 後) |
| [#145](https://github.com/almondoo/review-agent/issues/145) | config dry-run / preview | ⏳ 予定 (#146+#156 後) |
| [#155](https://github.com/almondoo/review-agent/issues/155) | feedback loop 👍/👎 → FP suppression | ⏳ 予定 |
| [#157](https://github.com/almondoo/review-agent/issues/157) | trigger control (manual/partial re-run, skip, label/comment) | ⏳ 予定 |
| [#149](https://github.com/almondoo/review-agent/issues/149) | inline-comment replies & conversation | ⏳ 予定 (#157 後) |

### [B] 設計判断が必要（spec 沈黙 / 大型・要 refine）

#134 richer PR summary / #135 local trial / #141 dashboard UX gaps /
#142 quality metrics / #150 onboarding & docs system / #152 committable suggestions /
#153 one-command start / #158 large-PR/monorepo strategy /
#160 external-tool ingestion (lint/types/SAST) / #162 platform 拡張 (GitLab/GHES)。

### [C] 外部リソース / 前提ブロック

#132 (GA per-principal authz — 認証モデル決定待ち) / #161 (dashboard RBAC — #132 依存) /
#137 (SSO — #161 依存) / #136 (audit log — #161 の actor identity 前提) /
#138 (retry/DLQ/alerting — #144 依存) / #140 (cost analytics — #144/#142 依存) /
#144 (notifications — #138/#140 のイベント源前提) / #154 (preset 配布 — npm publish 権限要)。

---

## Out-of-scope (各 issue 内 `## Out of scope` で明示済、独立 issue 化しない)

ここに列挙したものは「ニーズが顕在化した時に新規 issue として起票する」運用。

- LLM 自由テキスト解釈 (`thanks, fixed!` 自動分類) — epic #83 Q2
- GraphQL Resolve conversation state — GitHub API 未提供
- Pairwise LLM judge — #101 単発スコア完了後
- 人間フィードバック ↔ judge score correlation — #99 + #101 完了後
- CodeCommit 過去ログ scrape — #95 完了後
- Grafana JSON dump — #104 完成後
- BI ツール統合 terraform — vendor 個別
- `reviews.auto_review.base_branches` — auto-review epic 待ち (#84 内)
- GitHub draft review への `/feedback` — 仕様判断 (ADR)
