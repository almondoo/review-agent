# Audit log (HMAC chain)

`audit_log` is an append-only Postgres table that records every cost-incurring
or trust-boundary event in `review-agent`. Each row is hash-chained to the
previous row so that any retroactive edit, deletion, or insertion is detectable
by replay.

## Row shape

```sql
CREATE TABLE audit_log (
  id              BIGSERIAL PRIMARY KEY,
  ts              TIMESTAMPTZ DEFAULT now(),
  installation_id BIGINT,
  pr_id           TEXT,
  event           TEXT NOT NULL,
  model           TEXT,
  input_tokens    INT,
  output_tokens   INT,
  prev_hash       TEXT,
  hash            TEXT NOT NULL
);
```

See `packages/core/src/db/schema/audit-log.ts` for the canonical Drizzle
definition.

## Chain rule

```
hash_n = sha256( prev_hash_{n-1} || canonical_payload_n )
```

`canonical_payload` is a deterministic JSON string of the row's
`(ts, installationId, prId, event, model, inputTokens, outputTokens)` fields,
emitted in fixed key order by `canonicalPayload()` in
`packages/core/src/audit.ts`. The genesis row uses
`prev_hash = "0".repeat(64)` (constant `AUDIT_GENESIS_HASH`).

## Append path

Inserts go through `createAuditAppender(db)` in `@review-agent/db`. The
appender opens a short transaction, reads the highest-id row's `hash`, and
inserts a new row whose `prev_hash` is that value. The transaction
serializes concurrent appenders so the chain stays linear.

The appender is the **only** sanctioned write path. Direct `INSERT` /
`UPDATE` / `DELETE` from psql is treated as tampering and will be detected
by the verifier.

## Verifier

```
DATABASE_URL=postgres://... pnpm --filter @review-agent/eval verify:audit [installationId]
```

`scripts/verify-audit-chain.ts` reads rows in `id ASC` order, recomputes
`hash` for each, and reports breaks. Exits non-zero on the first break.

Recommended schedule: nightly (e.g. cron 02:00 UTC). Page on non-zero exit;
treat any break as a §8.6.5 incident (database compromise).

## Operational notes

- **Forward-only**: never `UPDATE` an existing row's payload. If business
  logic needs to correct a value, append a new row of `event = 'correction'`
  pointing at the original `id` in the payload.
- **Pruning**: `audit_log` grows unbounded. Operators may archive rows
  older than the retention requirement, but the prune script must export
  the chain to cold storage **before** delete, otherwise the verifier's
  next run will report a break at the new low-water mark.
- **Backups**: RDS automated snapshots cover this table. Do not skip the
  table in any backup policy you write — the audit log is regulatory
  evidence in the SOC2 / ISO 27001 sense.
- **Genesis row**: cycling the table (e.g. for tests) resets the chain.
  Production data must never start from a non-empty table without a
  matching `prev_hash` prefix.

## Actor identity in audit rows

`audit_log` rows do not store the GitHub actor that posted the
review comment — the actor is determined by the auth method
(`github-actions[bot]` for the Action, `<app-name>[bot]` for the
GitHub App, the PAT owner for the CLI). Operators that want a
uniform actor across the org should run Server mode with a renamed
GitHub App; see [`../configuration/bot-identity.md`](../configuration/bot-identity.md)
for the per-mode mapping and the rationale for not exposing actor as a
config knob.
