# On-call playbook

This is the operator companion to [`SECURITY.md`](../../SECURITY.md). It
sets out the SLOs for each incident response runbook, the escalation
path, the alarms that should page, and the format of the quarterly
tabletop drill.

For a self-hosted multi-tenant deployment, *you* are the on-call
responder — this project doesn't operate a hosted instance.

---

## SLO / SLA at a glance

| Runbook | Trigger | MTTA | MTTR | Severity |
|---|---|---|---|---|
| §8.6.1 LLM provider key compromised | Cost spike alert; provider billing alert | 5 min | < 15 min | SEV-1 |
| §8.6.2 GitHub App private key compromised | Audit-log entries from unknown IPs | 10 min | < 30 min | SEV-1 |
| §8.6.3 Webhook secret compromised | Receiver accepts replay / unknown source IP | 5 min | < 15 min | SEV-1 |
| §8.6.4 Rogue installation | Per-installation cost exhaustion / repeat injection | 30 min | < 4 hr | SEV-2 |
| §8.6.5 DB compromise | pgaudit DDL alert; HMAC chain break | 10 min | < 4 hr | SEV-1 |
| §8.6.6 Postgres lost (DR) | RDS unavailable; restore from snapshot needed | 15 min | < 1 hr | SEV-2 |

- **MTTA** = mean time to acknowledge (page → human eyes on the ticket).
- **MTTR** = mean time to remediate (page → cap-rotation / DB-restore /
  installation-revoked complete).

These are *targets*, not contractual commitments. A self-hosted
deployment's actual numbers depend on your alerting setup and on-call
rotation; calibrate them when you bake the alarms.

## Required alarms

Install at least these alarms on your CloudWatch / Grafana / Datadog
stack. Each is a recommended pager-trigger, not a guarantee.

| Alarm | Threshold | Runbook |
|---|---|---|
| `review_agent_cost_usd_total` rate spike | 5× the trailing 24h average over 5 minutes | §8.6.1 |
| `cost.threshold_crossed{threshold="kill"}` | any | §8.6.1 (or root-cause, may be a tool loop) |
| Audit-log gaps detected by `verifyAuditChainFromDb` | any break | §8.6.5 |
| `<name>-jobs-dlq` SQS message count | > 0 | per-runbook root cause |
| API Gateway 4xx rate | > 10% over 5 min | §8.6.3 (signature failures) |
| RDS instance unavailable / failover | any | §8.6.6 |
| Bedrock / OpenAI / Anthropic 401 / 403 rate | > 5% | §8.6.1 |
| `installation_secrets` row deletion | any (CloudTrail / pgaudit) | §8.6.4 (or §8.6.5) |

## Tabletop drill — quarterly

Goal: every responder has rehearsed §8.6.4 (rogue installation) at
least once before the real fire.

### Format

- **Cadence**: once per quarter, ~60 minutes.
- **Participants**: every operator with deploy access. Two roles:
  *driver* (executes the runbook) and *evaluator* (reads the runbook
  alongside, scores each step).
- **Environment**: a sandbox account / installation. Never run drills
  against production.
- **Pre-staging** (driver, before the meeting):
  1. Provision a sandbox installation against a dummy GitHub org.
  2. Seed it with synthetic activity — a few PRs, some review_state
     rows, a few cost_ledger entries.
  3. Mint a CMK for the installation, store a fake API key encrypted
     under it.

### Scenario script

> A new installation onboarded yesterday. Overnight,
> `review_agent_cost_usd_total` spiked to 30× the org's typical
> daily spend, all attributed to this installation. The cost ledger
> shows hundreds of `cost_exceeded` rows. The audit log shows the
> agent posted comments containing `[redacted]` markers — gitleaks
> scrub patterns from secrets the bot had to redact mid-prompt. The
> installation owner is non-responsive.
>
> Goal: revoke this installation in the next 30 minutes without
> destroying the audit trail.

### Steps the driver should execute

Follow §8.6.4 verbatim. Score each step on:

- **Found the right command on the first try?** (yes / no)
- **Verify step matched the documented expectation?** (yes / no)
- **Could a less-experienced operator follow the runbook?** (yes /
  partially / no)

Anything below "yes" / "yes" / "yes" is a runbook bug — file an issue
to clarify the documentation before the next drill.

### Evaluator checklist

- [ ] Driver opened the transaction with a role that bypasses RLS
      (the migrations superuser, not `review_agent_app`).
- [ ] Driver did not delete `audit_log` rows.
- [ ] Driver suspended the installation in the GitHub App settings.
- [ ] Driver scheduled the installation's KMS CMK for deletion with
      the recommended waiting period (`--pending-window-in-days 7`).
- [ ] Driver verified the per-table row counts after commit.
- [ ] Driver wrote up the customer-comms ticket within the drill
      window.

## Escalation

For a personal project, the escalation is straightforward: the
maintainer ([@almondoo](https://github.com/almondoo)). For a multi-
tenant operator, fill the table below with your own setup before the
first incident:

| Tier | Who | Reach |
|---|---|---|
| L1 (first responder) | _your on-call rotation_ | _PagerDuty schedule URL_ |
| L2 (engineering escalation) | _backend / infra lead_ | _Slack handle_ |
| L3 (customer comms) | _customer success / legal_ | _Slack handle_ |
| Vendor escalation: AWS | account TAM | _email_ |
| Vendor escalation: Anthropic | enterprise support | _email_ |
| Vendor escalation: GitHub | App owner contact | _GitHub Support_ |

## Post-incident review

Every SEV-1 / SEV-2 gets a post-mortem. Required fields:

- Timeline of events (UTC).
- Detection: what alarm fired? Was it the right one?
- Response: did the runbook MTTR target hold?
- Customer impact (which installations, what data).
- Root cause.
- Action items: runbook updates, alarm tuning, code fixes.

The post-mortem is internal. The customer-comms message is separate
and goes out within 72 hours per typical regulatory norms (GDPR /
CCPA). Both should reference the runbook section that was followed.

## Drift detection

Things that shift over time and break the runbooks if you don't
revisit:

- AWS Secrets Manager secret names ↔ Terraform variable names — keep
  the example in `examples/aws-lambda-terraform/` in sync.
- Bedrock model IDs — Anthropic ships new SKUs roughly twice a year;
  the `bedrock_model_id` Terraform default lags reality.
- KMS CMK ARN format — when AWS adds new key types, the policy in
  `docs/deployment/aws.md` may need updating.
- The `recover sync-state` CLI signature — track this against
  `packages/cli/src/commands/recover.ts`.

A 15-minute "runbook freshness" review at the start of each tabletop
drill catches most drift.
