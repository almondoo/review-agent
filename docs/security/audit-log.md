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
  hash            TEXT NOT NULL,
  actor           TEXT,          -- operator/service identity (nullable; migration 0011)
  resource_type   TEXT,          -- mutated resource kind (nullable; migration 0012)
  resource_id     TEXT           -- mutated resource identifier (nullable; migration 0012)
);
```

See `packages/core/src/db/schema/audit-log.ts` for the canonical Drizzle
definition.

### Actor column

`actor` records the operator or service that triggered the event. For
HTTP API events it is set to the JWT principal ID when the request
is authenticated (`c.get('principal')?.id`). For CLI events it is
set to `cli:<$USER>`. For events without an authenticated principal
(e.g. GitHub App webhook callbacks, `github_installation.setup`) it is
`null`. Legacy events written before migration 0011 also have `actor = null`.

### resource_type / resource_id columns

`resource_type` and `resource_id` capture the specific resource that was
mutated. Examples:

| event                       | resource_type        | resource_id                    |
|-----------------------------|----------------------|--------------------------------|
| `repo.create`               | `repo`               | repo UUID                      |
| `repo.enable` / `.disable`  | `repo`               | repo UUID                      |
| `repo.delete`               | `repo`               | repo UUID                      |
| `repo.bulk_register`        | `repo`               | installation ID (string)       |
| `prompt.update`             | `repo`               | repo UUID                      |
| `byok.key.upsert/rotate/delete` | *(not set)*      | *(not set)*                    |
| `github_installation.setup` | `github_installation`| installation ID (string)       |
| `membership.grant` / `.revoke` | `membership`      | `<principalId>:<installationId>` |
| `principal.create` / `.delete` | `principal`        | principal ID                   |
| `principal.password_change` | `principal`          | principal ID                   |

Both fields are nullable for backward compatibility. Existing rows written
before migration 0012 have `resource_type = null` and `resource_id = null`,
which does not affect chain verification (canonicalPayload omits null values).

## Admin mutation events

The following admin mutations are recorded in `audit_log` automatically:

- **`repo.create`** — POST /api/repos
- **`repo.enable`** / **`repo.disable`** — PATCH /api/repos/:id
- **`repo.delete`** — DELETE /api/repos/:id
- **`repo.bulk_register`** — POST /api/repos/bulk (GitHub App installation)
- **`prompt.update`** — PUT /api/repos/:id/prompt
- **`github_installation.setup`** — GET /github/setup (GitHub App OAuth callback)
- **`byok.key.upsert`** / **`byok.key.rotate`** / **`byok.key.delete`** — BYOK key management
- **`membership.grant`** / **`membership.revoke`** — CLI `review-agent user grant/revoke`
- **`principal.create`** / **`principal.delete`** / **`principal.password_change`** — CLI `review-agent user create/delete/set-password`

Secret material (API keys, passwords, hashes) is never included in any audit
field. resource_id contains only IDs, not key bytes or credentials.

## Chain rule

```
hash_n = sha256( prev_hash_{n-1} || canonical_payload_n )
```

`canonical_payload` is a deterministic JSON string of the row's
`(ts, installationId, prId, event, model, inputTokens, outputTokens)` fields,
emitted in fixed key order by `canonicalPayload()` in
`packages/core/src/audit.ts`. The genesis row uses
`prev_hash = "0".repeat(64)` (constant `AUDIT_GENESIS_HASH`).

When `actor`, `resourceType`, or `resourceId` are non-null they are appended
to the canonical JSON in that order. Rows where all three are null produce
a canonical payload byte-for-byte identical to rows produced before these
fields were introduced, preserving full backward compatibility.

## Append path

Inserts go through `createAuditAppender(db)` in `@review-agent/db`. The
appender opens a short transaction, sets the `app.current_tenant` GUC to the
event's `installationId` (when non-null), reads the highest-id row's `hash`
scoped to that installation, and inserts a new row whose `prev_hash` is that
value. The GUC ensures the `audit_log` RLS `tenant_isolation` policy allows
both the SELECT and the INSERT. The transaction serializes concurrent appenders
so the chain stays linear per installation.

The appender is the **only** sanctioned write path. Direct `INSERT` /
`UPDATE` / `DELETE` from psql is treated as tampering and will be detected
by the verifier.

### Global (null installationId) events — write-only limitation

Events without an `installationId` (e.g. `principal.create/delete/
password_change` from the CLI when no `--installation` flag is given) are
written with `installation_id = NULL`. The RLS `withCheck` permits this INSERT
(`installation_id IS NULL OR ...`), but the `using` clause requires
`installation_id::text = current_setting('app.current_tenant', true)`, which
never matches `NULL`. These rows are therefore **write-only under the app role**:
they are durably stored and auditable via a superuser / BYPASSRLS connection,
but invisible to tenant-scoped reads (`verifyAuditChainFromDb`,
`loadAuditLogForExport`, `audit export` CLI). There is no installation-scoped
HMAC chain for them (each write uses genesis hash as `prev_hash`).

Events **with** an `installationId` — including `membership.grant/revoke` and
`principal.create --installation` — are fully verifiable and exportable under
that installation's tenant context and are the recommended way to audit
principal/membership changes.

## Verifier

Operators verify the chain by calling `verifyAuditChainFromDb` from
`@review-agent/db` against the production database — typically wired
into a nightly cronjob or a small standalone script:

```ts
import { verifyAuditChainFromDb } from '@review-agent/db';
import { createDbClient } from '@review-agent/db';

const { db, close } = createDbClient({ url: process.env.DATABASE_URL! });
try {
  // Pass `{ installationId }` to scope the verification to one tenant.
  const report = await verifyAuditChainFromDb(db);
  if (!report.ok) alertOncall(report);
} finally {
  await close();
}
```

`verifyAuditChainFromDb` reads rows in `id ASC` order, recomputes
`hash` for each, and reports breaks. The returned `report.ok` is `false`
on the first break.

Recommended schedule: nightly (e.g. cron 02:00 UTC). Page on a `false`
report; treat any break as a §8.6.5 incident (database compromise).

## Operational notes

- **Forward-only**: never `UPDATE` an existing row's payload. If business
  logic needs to correct a value, append a new row of `event = 'correction'`
  pointing at the original `id` in the payload.
- **Pruning**: `audit_log` grows unbounded. Use `review-agent audit
  export` to archive a date range to gzipped JSONL (chain segment is
  verified pre-export), then `review-agent audit prune --before <date>
  --confirm` to delete rows older than the boundary. The prune keeps
  the most-recent row before the boundary as the new anchor so the
  surviving tail still chains correctly; the CLI re-verifies the chain
  segment post-prune and exits non-zero if it cannot. SOC2 recommends
  retaining at least 1 year of evidence — operators must decide and
  document their own policy. See
  [`../operations/retention.md`](../operations/retention.md) for the
  end-to-end runbook.
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
