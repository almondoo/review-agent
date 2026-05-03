# Threat-model review — 2026-05

Structured STRIDE walkthrough against the v0.3 / v1.0 attack
surface of `review-agent`. Spec reference: PRD §12.1 v1.0 (option
b: internal threat-model review), v1.0 issue #44, [`./audit.md`](./audit.md).

**Status**: drafted by the project maintainer (almondoo /
tsubasa.engineer@gmail.com). **Awaiting unaffiliated reviewer
sign-off** — see "Sign-off" at the bottom. Until that line is
filled in, this document is a draft and v1.0 tagging is gated.

Scope: every surface listed in the in-scope table below. Out of
scope: GitHub Actions runner platform itself, LLM provider
availability, user-supplied skill / `path_instructions` content
(documented in SECURITY.md "Out of scope").

---

## In-scope surfaces

| Surface | Code reference | Spec reference |
|---|---|---|
| Webhook receiver (HMAC + idempotency) | `packages/server/src/handlers/webhook.ts` + `middleware/verify-signature.ts` + `middleware/idempotency.ts` | §7.1, §7.2 |
| Job queue (SQS / GCP Pub/Sub / etc.) | `packages/server/src/queue/sqs.ts` + `core/queue.ts` | §7.5 |
| GitHub App auth + token cache | `packages/platform-github/src/app-auth.ts` | §7.4 |
| BYOK envelope encryption (per-installation) | `packages/core/src/kms/`, `packages/kms-aws/` | §8.5 |
| Postgres RLS (multi-tenant) | `packages/db/src/migrations/*` | §16.1 |
| Audit-log HMAC chain | `packages/core/src/audit.ts`, `packages/db/src/append.ts` | §13.3 |
| Cost ledger + per-installation hard cap | `packages/core/src/cost.ts`, `packages/runner/src/cost-*` | §6.2, §11.1, §17 |
| Agent loop tool surface (`read_file` / `glob` / `grep` only) | `packages/runner/src/tools.ts` | §11.2 |
| Sandbox (denylist + partial+sparse clone + non-root container) | `Dockerfile`, `packages/runner/src/tools.ts` | §11.2, §15.1 |
| Gitleaks (diff scan + agent-output scan) | `packages/runner/src/gitleaks.ts` | §11.3 |
| Prompt-injection guard (untrusted wrapper + LLM detector) | `packages/runner/src/middleware/injection-guard.ts`, `runner/src/security/injection-detector.ts` | §6.4, §11 |
| Hidden state comment + fingerprint dedup | `packages/runner/src/state-builder.ts`, `runner/src/middleware/dedup.ts` | §12.1 |
| Skill loader (frontmatter + script-stripping) | `packages/runner/src/skill-loader.ts` | §15.7.4 |
| Multi-bot coordination policy | `packages/runner/src/coordination.ts`, `config/src/known-bots.ts` | §22 #9, v1.0 #48 |
| Bot identity per distribution mode | per [`../configuration/bot-identity.md`](../configuration/bot-identity.md) | §22 #5, v1.0 #47 |

---

## Spoofing

What can an attacker pretend to be that they aren't?

| # | Attack | Mitigation | Residual risk |
|---|---|---|---|
| S-1 | Forged GitHub webhook (no valid HMAC) | `crypto.timingSafeEqual` over the raw body before JSON parse; missing and invalid signatures both 401 with identical body so timing attacks cannot distinguish failure modes. | None at the receiver. Operators must rotate the webhook secret on suspicion (§8.6.3 runbook). |
| S-2 | Replay of old webhook delivery | Idempotency table on `X-GitHub-Delivery`; duplicate delivery returns `{ deduped: true }` 200. Cleanup sweep removes rows > 7 days. | A window of 7 days where a leaked old signed body could be replayed against a previous receiver instance — but the receiver dedupes, so the worker only runs once. |
| S-3 | Spoofed Anthropic / OpenAI API responses (intercepted TLS) | Provider SDK uses the underlying TLS stack with default CA bundle. We do not pin certificates. | An attacker with CA-level position could MITM provider calls — out-of-scope per PRD risks §11.2 (provider availability), but operators in regulated environments should consider TLS inspection policy. |
| S-4 | Spoofed bot author (PR opened by `coderabbitai[bot]` to trigger deference) | `coordination.other_bots: defer_if_present` matches GitHub's `[bot]` actor field which a non-bot account cannot impersonate. | None at the protocol level — actor authenticity is GitHub's responsibility. |
| S-5 | Forged per-installation BYOK secret | Secrets are envelope-encrypted at rest and the data-key is wrapped under a per-installation CMK. Rotation drops the data-key. | A KMS misconfiguration that grants cross-installation `kms:Decrypt` would breach isolation — KMS policy review is part of `byok.md` runbook. |

Findings: none `high` or `critical`. S-3 is informational
(industry-default trust model). S-5 has documented mitigation in
`byok.md`.

---

## Tampering

What can an attacker modify in flight or at rest?

| # | Attack | Mitigation | Residual risk |
|---|---|---|---|
| T-1 | Modified PR diff body before agent reads it | Agent fetches the diff via the GitHub API (TLS), not from arbitrary mirrors. Octokit retries on transient failures only — no fallback to plaintext. | None at the protocol level. |
| T-2 | Tampered agent-output before `gitleaks` post-scan | Gitleaks runs on agent text in-process before posting; output is held in memory until scan completes. There is no intermediate file write that another process could touch. | None — single-process invariant. |
| T-3 | Modified hidden state comment to skip review (`<!-- review-agent-state: ... -->`) | The runner treats the state comment as a hint, not a security boundary. Modified state can re-trigger a full re-review (worst case: extra cost, capped by `cost-cap-usd`). It cannot bypass the review entirely because `decideSkip` does not consult it. | An attacker can churn the state comment to drive cost — bounded by per-installation daily cap (§17). Acceptable. |
| T-4 | Audit-log row tampering (DB compromise) | HMAC chain (`hash_n = sha256(prev_hash || canonical_payload_n)`); `recover audit-verify` detects any modification. Verifier runs nightly (recommended). | A tamperer with both DB write and the chain salt could theoretically forge a consistent chain — but the salt is derived from `prev_hash`, not a separate secret, so the forge is computationally bounded by the SHA-256 collision space. Acceptable. |
| T-5 | Modified skill content in `.review-agent/skills/` | Skill loader strips `<script>` tags and dangerous fenced-code blocks (`bash` / `sh` / `python` / `powershell`). 50 KB max size. Untrusted-content wrapper marks skill body as not instructions. | An LLM might still treat skill content as authoritative even with the wrapper. The `skill-loader.test.ts` covers the strip; the LLM-side trust is mitigated by the injection detector (`runner/src/security/injection-detector.ts`). |

Findings: none `high` or `critical`. T-3 and T-5 have documented
mitigations and acceptable residual risk.

---

## Repudiation

What actions can an attacker take and then deny?

| # | Attack | Mitigation | Residual risk |
|---|---|---|---|
| R-1 | Operator denies running an expensive prompt | `audit_log` HMAC chain records every cost-incurring event with `installation_id`, `pr_id`, `event`, `model`, `input_tokens`, `output_tokens`. Forward-only with chain replay. | None at the protocol level. The forensic record is regulatory-grade (§8.6.5). |
| R-2 | Worker process emits a comment then disappears | Server posts the comment via Octokit which logs the operation in the GitHub PR timeline. The Lambda log retains the request. | Comment authorship is tied to the bot identity per [`../configuration/bot-identity.md`](../configuration/bot-identity.md) — per-mode mapping is documented so auditors know which actor maps to which deployment. |
| R-3 | Tenant denies agreeing to a config policy | Org config is read from `<owner>/.github/review-agent.yml` at job time and the source is recorded in OTel (`metrics.configSourceTotal.add(1, { source })`). | Telemetry is operator-side, not a hard audit row. Acceptable for the org-config trust model. |

Findings: none. Audit-log + GitHub timeline + OTel cover the
relevant cases.

---

## Information disclosure

What sensitive data can an attacker read?

| # | Attack | Mitigation | Residual risk |
|---|---|---|---|
| I-1 | Agent reads `.env` / `.git/config` / `node_modules/` lockfiles | Static denylist in `tools.ts`; partial+sparse clone of changed paths only, rooted at the clone dir. Symlinks are refused (`statSync(file).isSymbolicLink()`). | None at the tool layer. An attacker who lands a path in the diff that resolves into a denylisted dir gets refused with `ToolDispatchRefusedError`. |
| I-2 | Secret in agent reasoning leaks via posted comment | Two-stage gitleaks: diff scan + agent-text scan. Review aborts on positive hit (`shouldAbortReview` returns true). Tested via `runner/src/gitleaks.test.ts`. | A custom secret format not in gitleaks's default rules could slip through — operators add `redact_patterns` in `.review-agent.yml` for org-specific secrets. |
| I-3 | Cross-tenant data leak via shared Postgres | RLS `tenant_isolation` policy on every tenant-scoped table; `app.current_tenant` GUC is required for read; fails closed when GUC unset. Migrations superuser path is the only RLS-bypass and is gated to migration scripts. | A code path that forgets `SET LOCAL app.current_tenant = '<id>'` would silently return zero rows (fail-closed). Tested in db/src/__tests__/rls.test.ts. |
| I-4 | Per-installation BYOK secret read by neighbouring installation | Envelope encryption: data-key wrapped under per-installation CMK. Decryption requires both the wrapped data-key and `kms:Decrypt` on the CMK ARN. KMS policy scopes by installation. | Cross-installation `kms:Decrypt` grant is the only way to breach isolation — operator audit responsibility per `byok.md`. |
| I-5 | Prompt-injection extracts the system prompt | Untrusted-content wrapper + injection detector + the agent loop's own instruction-following defenses. Red-team eval has 15 fixtures targeting this. | Bypass attempts that the eval doesn't cover are possible — the eval gate is `red_team_bypass_count = 0` (`baseline.json`); any new bypass is treated as a red-team fixture and shipped in the fix PR. |
| I-6 | Cost-ledger HMAC chain entry leaks PR contents | `audit_log` rows store metadata only (`event`, `model`, token counts, `pr_id`), not prompt/completion bodies. Body redaction is enforced by `body-redaction.ts`. | None at the row schema level. |
| I-7 | Debug logs include the inference API key | API keys are read via env vars and never written to OTel attributes or stdout. `body-redaction.ts` strips `Authorization` headers from spans. | An operator wiring custom OTel attributes could log it manually — out-of-band review responsibility. |

Findings: none `high` or `critical`. I-2 and I-5 depend on the
ongoing red-team / detection-rule maintenance cadence.

---

## Denial of service

What can an attacker do to make the agent unavailable or expensive?

| # | Attack | Mitigation | Residual risk |
|---|---|---|---|
| D-1 | PR opened with a 10MB diff to inflate cost | `reviews.max_diff_lines` (default 3000), `reviews.max_files` (default 50), per-PR `cost-cap-usd` (default 1.0), per-installation `daily_cap_usd` (default 50). The cost-guard middleware short-circuits the loop when the cap is reached. | None at the cap level. An attacker can saturate the daily cap to lock other PRs for 24h — operators tune the cap based on their volume. |
| D-2 | High-frequency PR open / synchronize loop | Synchronize debounce (`startWorker` checks the latest `review_state` head SHA and drops messages within the 5s debounce window). | Sustained high-frequency push from a compromised installation would still consume worker CPU until the cap kicks in — acceptable. |
| D-3 | Webhook receiver overload | Lambda concurrency cap, SQS queue absorbs bursts, partial-batch failure handler isolates poison messages (`maxReceiveCount: 5` then DLQ). | None at the protocol level. |
| D-4 | Agent loop infinite tool calls | Tool-call budget per turn; cost-guard middleware aborts when projected cost exceeds the cap. | None — bounded by cap. |
| D-5 | LLM-based injection detector loop | Detector cache (`createInMemoryDetectorCache`) deduplicates classifications per process. The detector itself is bounded by token budget. | The detector adds ~$0.001/PR overhead (PRD §22 #14); this is mandatory in v1.0 with `INJECTION_DETECTOR_OPT_OUT_ENV` for opt-out where defended in another layer. |

Findings: none `high` or `critical`. D-1 and D-5 are budget-bounded
by design.

---

## Elevation of privilege

What can an attacker do to gain capabilities they shouldn't have?

| # | Attack | Mitigation | Residual risk |
|---|---|---|---|
| E-1 | Agent escapes the sandboxed clone directory | `read_file` resolves the requested path against the clone root and refuses traversal. The `agent` user inside the container is non-root and `REVIEW_AGENT_SANDBOXED=1` is set. | A bug in the path-resolution code is the entire boundary — `runner/src/tools.test.ts` covers `..` traversal, symlink, and absolute-path attacks. |
| E-2 | Agent issues GitHub API calls outside the configured tool surface | The agent loop only ever exposes `read_file` / `glob` / `grep` to the LLM. There is no tool that lets the LLM call the GitHub API. | None at the loop level. The only GitHub API caller is the platform adapter, which is invoked by the runner / action wrapper, not by tool dispatch. |
| E-3 | Skill content tells the agent to skip the review | Untrusted-content wrapper marks skill body as informational-only; injection detector classifies suspect content. | An LLM that ignores the wrapper is still bounded by the deterministic post-processing — `dedupComments` and `gitleaks` run regardless of the agent's narrative. |
| E-4 | A multi-tenant operator escalates to another tenant via SQL injection | All Postgres queries use Drizzle's parameterised placeholders. No raw `${}` interpolation in `packages/db/src/`. | None at the query layer. |
| E-5 | Bot identity confusion between Action and Server modes lets one masquerade as the other | Per [`../configuration/bot-identity.md`](../configuration/bot-identity.md), GitHub determines the actor per auth method; there is no config knob that lets a deployment misrepresent its mode. | None at the protocol level. |

Findings: none. The single-purpose tool surface and Drizzle-only
query layer materially shrink the EoP attack surface.

---

## Summary of findings

**Pre-review counts** (drafted by maintainer, awaiting reviewer
sign-off):

| Severity | Count | Notes |
|---|---|---|
| Critical | 0 | — |
| High | 0 | — |
| Medium | 0 | — |
| Low | 0 | — |
| Informational | 4 | S-3 (TLS pinning policy), T-3 (state-comment churn driving cost — bounded by cap), I-2 (custom secret formats — operator-extensible via `redact_patterns`), D-1 (daily-cap saturation lock — operator-tunable). |

No findings block v1.0 tagging on technical merit. The remaining
gate is the unaffiliated-reviewer sign-off below.

If the reviewer flags additional findings, this section is
updated to reflect them and the corresponding rows are added to
the relevant STRIDE category above.

---

## Recommendations for v1.x follow-up

These are not v1.0 blockers but are tracked for the next minor:

1. **Cosign attestation for first-party skills** — currently a
   wontfix per v1.0 issue #51 (no `@review-agent/skill-*`
   packages exist). Re-evaluate when the first skill is published.
2. **Custom-secret format library**: ship a starter
   `redact_patterns` example for common per-org secret formats
   (UUID-suffixed tokens, internal `acme-*` prefixes). Today
   operators have to write the regex from scratch.
3. **TLS pinning policy guidance** in `docs/security/`: document
   the operator's options for TLS inspection / pinning when their
   network policy requires it. Today the project trusts the
   default CA bundle.
4. **Redacted forensic export tool**: a `review-agent forensics
   export-audit` CLI subcommand that exports the audit-log chain
   in a portable, redacted form for a customer-comms ticket.
   Today operators run `psql` directly.

---

## Sign-off

This walkthrough is **drafted** and **not yet signed off**. The
maintainer's sign-off alone does NOT close v1.0 issue #44 — see
[`./audit.md`](./audit.md) for the procedure.

| Reviewer | Affiliation | Date | Verdict |
|---|---|---|---|
| almondoo (Tsubasa) | maintainer (primary author) | 2026-05-03 | drafted |
| _TBD — unaffiliated reviewer required_ | _TBD_ | _TBD_ | _pending_ |

When the unaffiliated reviewer signs off, append a row above and
flip the STATUS line at the top of this document. v1.0 issue #44
can then be closed.

---

## Cross-references

- [`./audit.md`](./audit.md) — procedure and decision rationale.
- [`../../SECURITY.md`](../../SECURITY.md) — published threat model (kept in sync with this walkthrough).
- [`../../UPGRADING.md`](../../UPGRADING.md) — public API surface that the walkthrough's `tampering` and `EoP` sections protect.
