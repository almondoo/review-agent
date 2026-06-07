# review-agent documentation

`review-agent` is a self-hosted, multi-provider AI code review agent. Distributed
as a **GitHub Action**, **webhook server on Lambda/SQS**, and **CLI** from a
single TypeScript monorepo.

> **Start here**: [Quickstart — zero to first review in 10 minutes](./getting-started/quickstart.md)

---

## Getting started

| Page | What it covers |
|---|---|
| [Quickstart](./getting-started/quickstart.md) | Zero to first review — three paths (CLI trial / GitHub Action / self-hosted server) |
| [GitHub Action](./getting-started/action.md) | CI-integrated review, no server required |
| [CLI](./getting-started/cli.md) | Local trial, pre-commit gate, `config validate`, `eval` |
| [Self-hosted server](./getting-started/server.md) | Webhook server quickstart: GitHub App setup, docker compose, health check |
| [Skills](./getting-started/skills.md) | Teach the agent domain-specific review rules via Markdown skill files |

---

## Configuration

| Page | What it covers |
|---|---|
| [Config reference](./configuration/config-reference.md) | Every `.review-agent.yml` key: type, default, scope, examples |
| [Preset authoring](./configuration/preset-authoring.md) | Write, extend, and chain reusable presets |
| [Org config / extends](./configuration/extends.md) | Org-wide central config + bundled preset semantics |
| [Reviews](./configuration/reviews.md) | Auto-review triggers, path filters, size caps |
| [Schema validation](./configuration/schema-validation.md) | Ruleset / schema validation settings |
| [Ruleset](./configuration/schema-validation.md) | Per-category enable/min_severity (see config-reference `ruleset` section) |
| [Feedback](./configuration/config-reference.md#feedback) | False-positive suppression (`feedback.suppress_after`) |
| [Suggestions](./configuration/suggestions.md) | Inline suggestion block rendering |
| [Large PR](./configuration/large-pr.md) | Chunked review for oversized diffs |
| [External tools](./configuration/external-tools.md) | SARIF ingest from CI static-analysis tools |
| [Trigger control](./configuration/trigger-control.md) | Label-based trigger / skip |
| [Review output](./configuration/review-output.md) | Comment format and summary rendering |
| [Conversation](./configuration/conversation.md) | Inline reply and conversation turns |
| [Path instructions](./configuration/path-instructions.md) | Per-path agent instructions |
| [Privacy](./configuration/privacy.md) | Redact patterns, deny paths, allowed URL prefixes |
| [Repo](./configuration/repo.md) | Submodules, LFS |
| [Bot identity](./configuration/bot-identity.md) | GitHub actor per distribution mode (#47) |
| [Migration: DB systemPrompt](./configuration/migration-db-systemprompt.md) | Migrating from v0.x DB-based config to `.review-agent.yml` (#100) |
| [Coordination](./configuration/coordination.md) | Coexistence with other PR-review bots |

---

## Providers

| Page | What it covers |
|---|---|
| [Parity matrix](./providers/parity-matrix.md) | Feature / eval / cost comparison across all 7 providers |
| [Anthropic](./providers/anthropic.md) | API key, models, prompt caching, rate limits |
| [OpenAI](./providers/openai.md) | API key, models, structured output |
| [Azure OpenAI](./providers/azure-openai.md) | Deployment name, resource endpoint, data residency |
| [Google AI Studio](./providers/google.md) | Gemini models via AI Studio API key |
| [Vertex AI](./providers/vertex.md) | ADC / Workload Identity, Claude + Gemini on GCP |
| [AWS Bedrock](./providers/bedrock.md) | IAM credentials, model access, cross-region inference |
| [OpenAI-compatible](./providers/openai-compatible.md) | Ollama, vLLM, OpenRouter, LM Studio, LiteLLM |

---

## Deployment

| Page | What it covers |
|---|---|
| [docker-compose](./deployment/docker-compose.md) | One-command self-hosted stack for single-node use (#153 / C7) |
| [AWS](./deployment/aws.md) | Lambda + SQS + RDS production deployment |
| [GCP](./deployment/gcp.md) | Cloud Run + Pub/Sub + Cloud SQL |
| [Azure](./deployment/azure.md) | Azure Container Apps + Service Bus + Azure Database for PostgreSQL |
| [GitHub Marketplace](./deployment/marketplace.md) | Action publish, tag strategy, Marketplace runbook |
| [GHES](./deployment/ghes.md) | GitHub Enterprise Server specifics |

---

## Security

| Page | What it covers |
|---|---|
| [SECURITY.md](../SECURITY.md) | Vulnerability disclosure policy (#12) |
| [Audit log](./security/audit-log.md) | Immutable review audit trail |
| [Audit](./security/audit.md) | Audit operations guide |
| [BYOK](./security/byok.md) | Bring-Your-Own-Key: per-installation LLM key isolation |
| [Threat model (2026-05)](./security/threat-model-review-2026-05.md) | Threat model review |
| [Red team](./security/red-team.md) | Prompt-injection red-team findings |
| [Skill attestation](./security/skill-attestation.md) | Skill file integrity verification |
| [Multi-tenant authz](./security/multi-tenant-authz.md) | Installation isolation |
| [Dashboard auth](./security/dashboard-auth.md) | Dashboard authentication |
| [SSO (OIDC)](./security/sso.md) | OIDC single sign-on for the dashboard |
| [Feedback command authz](./security/feedback-command-authz.md) | Who can submit 👎 reactions |
| [On-call](./security/oncall.md) | Security on-call runbook |

---

## Architecture

| Page | What it covers |
|---|---|
| [Feedback loop](./architecture/feedback-loop.md) | 👎-driven suppression data flow |
| [Learned facts](./architecture/learned-facts.md) | Persistent learned-fact store |
| [Observability](./architecture/observability.md) | OTel spans, metrics, body-redaction |
| [Review / eval event](./architecture/review-eval-event.md) | Review event schema |

---

## Operations

| Page | What it covers |
|---|---|
| [SLO playbook](./operations/slo-playbook.md) | SLO targets, alerting, escalation (#104) |
| [Feedback suppression](./operations/feedback-suppression.md) | Mute list management, backfill |
| [Feedback backfill](./operations/feedback-backfill.md) | Backfill historical 👎 reactions |
| [Retention](./operations/retention.md) | Postgres data retention policy |
| [CodeCommit disaster recovery](./operations/codecommit-disaster-recovery.md) | CodeCommit-specific DR |
| [Review / eval event playbook](./operations/review-eval-event-playbook.md) | Handling review eval events |
| [v1.2 worker example](./operations/v1-2-worker-example.md) | Worker wiring example for v1.2 |

---

## Eval

| Page | What it covers |
|---|---|
| [Baseline measurement](./eval/baseline-measurement.md) | How baseline precision / FP numbers are measured |
| [Golden PRs](./eval/golden-prs.md) | The 60-fixture golden PR corpus |
| [LLM-as-judge](./eval/llm-as-judge.md) | LLM-as-judge evaluation methodology |

---

## Cost

| Page | What it covers |
|---|---|
| [Cost guide](./cost/index.md) | Per-PR cost estimation, daily cap, provider comparison |

---

## Upgrading

| Page | What it covers |
|---|---|
| [UPGRADING.md](../UPGRADING.md) | Breaking changes and migration steps per version (#43) |

---

## Specs (internal)

| Page | What it covers |
|---|---|
| [Review-agent spec](./specs/review-agent-spec.md) | Full design spec (~118 KB) |
| [PRD](./specs/prd.md) | Long-term product vision |
| [CodeCommit web embedded auto-setup spec](./specs/codecommit-web-embedded-auto-setup.md) | Design spec for AWS CodeCommit web-embedded setup |
| [Session handoff 2026-05-29](./specs/session-handoff-2026-05-29-dashboard.md) | Session handoff notes (dashboard / CodeCommit) |
| [Roadmap](./roadmap.md) | Wave status, active issues, operator-runtime backlog |
| [Release process](./release-process.md) | Release and tagging runbook |
| [README (Japanese)](./README.ja.md) | Japanese README |
