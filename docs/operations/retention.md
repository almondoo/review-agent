# Retention policy — `audit_log` and `cost_ledger`

Both `audit_log` and `cost_ledger` are append-only Postgres tables. Neither
has a hard-coded retention period — the operator decides, documents, and
enforces it. This page describes the recommended baseline, the operational
mechanics for enforcing it, and the constraints unique to the HMAC-chained
`audit_log`.

## Recommended baseline

| Table         | Minimum                | Notes                                            |
|---------------|------------------------|--------------------------------------------------|
| `audit_log`   | ≥ 1 year (SOC2 evidence) | Regulatory evidence; archive before pruning.    |
| `cost_ledger` | ≥ 1 year (SOC2 evidence) | Used for billing reconciliation and forecasting. |

SOC2 (CC4, CC7) treats both tables as evidence: `audit_log` covers
trust-boundary events (review starts, completions, secret-leak aborts,
cost-cap exceeded), and `cost_ledger` covers per-LLM-call spend by
installation. ISO 27001 Annex A.12.4.1 (event logging) reads similarly.

Operators may keep longer if their regulatory regime requires it (HIPAA:
6 years, PCI: 1 year, etc.). The CLI does not enforce a maximum.

You **must** write your chosen retention period into your `SECURITY.md` /
runbook and have it reviewed alongside any access-control change.

## Required DB role

Run the CLI with a `DATABASE_URL` that connects via an RLS-bypassing
role (the same role used by migration scripts, or a dedicated
`review_agent_admin` role). The CLI does not wrap its queries in
`withTenant(...)`, so an `appRole` connection will silently return zero
rows (RLS fail-closed) and the prune will be a no-op. The CLI is the
second sanctioned RLS bypass alongside migrations — keep it scoped to
operators with the same trust posture as the migrations runner.

## Operational mechanics

### Step 1 — export

```sh
review-agent audit export \
  --installation 12345 \
  --since 2025-01-01 \
  --until 2025-12-31 \
  --output ./audit-2025.jsonl.gz
```

- Filters by `installation_id` + `ts` range.
- Emits gzipped JSONL with discriminated rows (`{ "kind": "audit", … }` and
  `{ "kind": "cost", … }`).
- Verifies the `audit_log` chain segment **before writing** — a tainted
  archive is worse than no archive, so a chain break aborts the export.

Archive the resulting `.jsonl.gz` to cold storage (S3 Glacier, GCS
Archive, etc.) before pruning anything. The export is the only thing
proving what was in the row before deletion.

### Step 2 — prune (dry run)

```sh
review-agent audit prune --before 2025-01-01
```

Without `--confirm`, the CLI reports what would be deleted without
touching the table. Treat this as the equivalent of `terraform plan` —
read the output before proceeding.

### Step 3 — prune (commit)

```sh
review-agent audit prune --before 2025-01-01 --confirm
```

Deletes rows from both tables. For `audit_log`, the most-recent row
with `ts < --before` is **kept as the new anchor** so the surviving tail
still chains correctly via that row's `hash`. After delete, the CLI
re-verifies the chain segment; a verification failure exits non-zero.
`cost_ledger` has no chain; every row before the boundary is deleted.

### Step 4 — verify

Run a chain verification after every prune by calling
`verifyAuditChainFromDb` from `@review-agent/db` against the production
database (see [`docs/security/audit-log.md`](../security/audit-log.md)
"Verifier" for the wiring). Page on a `false` report; treat a break as a
§8.6.5 incident.

## What the prune is not

- The chain is **per-tenant under the production RLS configuration** —
  the appender's `prev_hash` lookup
  (`SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1`) is scoped to
  the current installation by the `tenant_isolation` policy on
  `audit_log`. The CLI must therefore run with an RLS-bypass DB role
  (the migrations superuser or equivalent — see "Required DB role"
  above) so its global anchor query and verifier observe every
  tenant's chain. With an `appRole` connection, the CLI sees zero rows
  (RLS fail-closed) and is a no-op. Under the bypass role, the
  CLI's prune walks the union of every tenant's chain in a single
  pass — operators who need a per-tenant retention policy must apply
  the prune boundary per `installation_id` themselves; the global
  `--before` here trims all tenants symmetrically. If a single tenant
  requests deletion under a data-rights regime (GDPR Art. 17, etc.),
  the right tool is a redaction event — see
  `docs/security/audit-log.md` for the redaction-vs-deletion split.
- It is **not** a substitute for backups. Take the export, ship it to
  cold storage, **then** prune.
- It is **not** retroactive on `webhook_deliveries` — that table has its
  own 7-day sweep in `packages/server/src/worker.ts` and is not part of
  this command.

## CI / scheduled enforcement

Wire `review-agent audit prune --before <90-days-ago> --confirm` into a
nightly cron (e.g. EventBridge → Lambda → CLI binary, or a GitHub
Actions schedule). Page on non-zero exit. Track the run via the chain
verifier the morning after to detect a silent failure mode.

## Recovery

If a prune accidentally deletes too much:

1. Stop further appends (kill the Server worker / pause the Action).
2. Restore the table from the last RDS snapshot to a separate database.
3. Replay the missing rows via the audit appender against the production
   DB — `audit_log` is append-only by design and replays cleanly.
4. Re-verify the chain segment end-to-end before resuming appends.
