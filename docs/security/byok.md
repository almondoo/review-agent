# BYOK — per-installation provider keys with KMS envelope encryption

This document covers how a multi-tenant `review-agent` deployment stores each
installation's LLM-provider API key encrypted at rest, how the worker decrypts
it just-in-time at review time, how to rotate keys, and what to do when a key
is suspected compromised.

Spec references: §8.5, §8.6.1, §8.7, §13.3, §16.1.

Implementation references:

- Schema: `packages/core/src/db/schema/byok-store.ts`
- Envelope helpers: `packages/core/src/kms/envelope.ts`
- KMS abstraction: `packages/core/src/kms/types.ts`
- Repository (upsert/read/rotate/remove): `packages/db/src/byok-store.ts`
- HTTP endpoints: `packages/server/src/api/llm-keys.ts`
- Tenant scoping: `packages/db/src/tenancy.ts`

---

## When you need this

Single-tenant deployments (one GitHub installation = one Anthropic key in env)
do **not** need BYOK. Set `ANTHROPIC_API_KEY` and skip this file.

Multi-tenant deployments (one webhook server, many installations, each with
their own provider key) **must** use BYOK. Otherwise the only way to scope keys
is one process per tenant — which does not scale.

The schema's `(installation_id, provider)` primary key means a single
installation can BYOK to several providers at once (e.g., Anthropic for
production repos, OpenAI for one experimental repo).

---

## At-rest storage model

### What is stored

Every BYOK secret lives in the `installation_secrets` table. No other table
holds plaintext or ciphertext API keys. The plaintext key is **never** written
to the database, application logs, or HTTP responses.

| Column | Type | Contents |
|---|---|---|
| `installation_id` | `bigint` | GitHub App installation ID (tenant scope key) |
| `provider` | `text` | Provider identifier — one of the values in `BYOK_PROVIDERS` |
| `kms_key_id` | `text` | CMK ARN / resource name used to wrap the data key |
| `wrapped_data_key` | `bytea` | AES-256 data key wrapped by KMS; opaque without CMK access |
| `encrypted_secret` | `bytea` | AES-256-GCM ciphertext of the customer's API key |
| `iv` | `bytea` | 96-bit GCM initialisation vector (random per write) |
| `auth_tag` | `bytea` | 128-bit GCM authentication tag |
| `created_at` | `timestamptz` | Row creation time |
| `rotated_at` | `timestamptz` | Last upsert / rotate time (updated on every write) |

Primary key: `(installation_id, provider)` — one row per installation per
provider. Upserts replace the row in place.

Supported `provider` values (from `packages/core/src/kms/types.ts`):
`anthropic`, `openai`, `azure-openai`, `google`, `vertex`, `bedrock`,
`openai-compatible`.

### Envelope encryption scheme

For every secret write a **fresh 256-bit AES data key** is generated via
`node:crypto` `randomBytes(32)`. The data key is used to AES-256-GCM encrypt
the plaintext API key (96-bit random IV, 128-bit auth tag). The data key is
then handed to KMS to be wrapped under the operator's CMK. Only the wrapped
form (`wrapped_data_key`) is persisted alongside the ciphertext, IV, and auth
tag. The plaintext data key is zeroed in memory (`Buffer.fill(0)`) and
discarded immediately after use.

```
customer API key (plaintext)
        │
        ▼
AES-256-GCM encrypt
(fresh 256-bit data key, 96-bit IV)
        │
        ├── encrypted_secret  → stored in Postgres
        ├── iv                → stored in Postgres
        └── auth_tag          → stored in Postgres

data key (plaintext)
        │
        ▼
KMS Encrypt(dataKey, kmsKeyId)
        │
        └── wrapped_data_key  → stored in Postgres

kmsKeyId ──────────────────── stored in Postgres (kms_key_id column)

plaintext data key → zeroed + discarded (never stored)
plaintext API key  → never stored
```

Implementation: `packages/core/src/kms/envelope.ts` (`encryptWithDataKey`,
`generateDataKey`) and `packages/db/src/byok-store.ts` (`upsertWithSecret`).

### Decryption at review time

```
wrapped_data_key + kms_key_id
        │
        ▼
KMS Decrypt → data key (plaintext, in memory only)
        │
        ▼
AES-256-GCM decrypt(encrypted_secret, iv, auth_tag)
        │
        ▼
customer API key (plaintext, in scope for one LLM call)
        │
        └── data key zeroed after decrypt
```

A tag mismatch or corruption throws — GCM authenticates, so corrupted or
tampered ciphertext is never silently decrypted.

Implementation: `packages/db/src/byok-store.ts` (`read`).

### What is explicitly not stored

- The plaintext API key is never written to the database, application logs,
  `stdout`, `stderr`, or HTTP response bodies.
- The plaintext data key (the 256-bit AES key used for the envelope) is never
  written to the database.
- Test suite asserts the no-log constraint with `console.log` / `console.error`
  spies (see `packages/db/src/byok-store.ts` implementation comments).

---

## Tenant isolation (§16.1)

The `installation_secrets` table has Postgres Row-Level Security enabled with a
`tenant_isolation` permissive policy bound to the `review_agent_app` role:

```sql
USING (installation_id::text = current_setting('app.current_tenant', true))
WITH CHECK (installation_id::text = current_setting('app.current_tenant', true))
```

Every query against the table must be wrapped in `withTenant(db, installationId,
fn)` (from `packages/db/src/tenancy.ts`), which sets the `app.current_tenant`
GUC for the duration of the transaction via `set_config(..., true)` (the third
argument `true` makes it transaction-local and discarded on commit/rollback).

**Fail-closed**: when `app.current_tenant` is unset, `current_setting(..., true)`
returns `NULL`, so the RLS policy denies all rows. Forgetting `withTenant` yields
zero results, not a cross-tenant leak.

---

## Setting up the KMS CMK

### AWS

Create a customer-managed CMK with **annual key rotation** enabled (per spec
§8.7):

```bash
aws kms create-key \
  --description "review-agent BYOK envelope" \
  --key-usage ENCRYPT_DECRYPT \
  --customer-master-key-spec SYMMETRIC_DEFAULT \
  --tags TagKey=Application,TagValue=review-agent

# Capture KeyId from the output:
CMK=arn:aws:kms:us-east-1:123456789012:key/<uuid>

aws kms enable-key-rotation --key-id $CMK

# Add an alias so rotation / re-key operations don't drift through config files:
aws kms create-alias --alias-name alias/review-agent-byok --target-key-id $CMK
```

The worker IAM role needs only `kms:Encrypt` and `kms:Decrypt` on the CMK ARN
— never `kms:*` on `*`:

```json
{
  "Effect": "Allow",
  "Action": ["kms:Encrypt", "kms:Decrypt"],
  "Resource": "arn:aws:kms:us-east-1:123456789012:key/<uuid>"
}
```

Set the CMK reference in the server env:

```bash
REVIEW_AGENT_BYOK_KMS_KEY_ID=arn:aws:kms:us-east-1:123456789012:alias/review-agent-byok
```

The server sources `kmsKeyId` from this env var only — the request body never
supplies it (enforced in `packages/server/src/api/llm-keys.ts`).

### GCP / Azure

The shared `KmsClient` interface (`packages/core/src/kms/types.ts`) is
cloud-agnostic. GCP (`@review-agent/kms-gcp`) and Azure (`@review-agent/kms-azure`)
implementations are follow-on packages. The schema, repository, envelope helpers,
and audit hooks require no changes when those land.

---

## Registering a BYOK key (initial setup)

### Via the dashboard (UI)

Navigate to **Settings → Integrations → LLM Keys** (route `/integrations/keys`,
landed in #121). Enter the provider and API key; the dashboard calls
`POST /api/integrations/llm-keys`. The input uses `type="password"` and is
cleared on submit. The stored key is never rendered back.

### Via the API

```bash
curl -X POST https://<host>/api/integrations/llm-keys \
  -H "Authorization: Bearer $REVIEW_AGENT_DASHBOARD_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"installationId": 12345678, "provider": "anthropic", "apiKey": "sk-ant-..."}'
```

Response (HTTP 200): `{ "installationId": 12345678, "provider": "anthropic", "configured": true }`.
The plaintext key is never echoed back.

An `audit_log` entry with `event: "byok.key.upsert"` is written inside the same
transaction (§13.3).

### Verify configuration

```bash
curl "https://<host>/api/integrations/llm-keys?installationId=12345678" \
  -H "Authorization: Bearer $REVIEW_AGENT_DASHBOARD_TOKEN"
```

Response: `{ "installationId": 12345678, "keys": [{ "provider": "anthropic", "configured": true }, ...] }`.
No secret material is returned.

---

## Key rotation

`store.rotate()` (`packages/db/src/byok-store.ts`) re-wraps the existing
secret under (possibly new) CMK with a fresh data key + IV. The plaintext
customer key itself is unchanged — rotating *our envelope*, not the upstream
provider key. Rotating the provider key requires a separate step.

### Routine rotation (envelope, quarterly)

The following procedure re-generates the AES data key and IV without changing
the upstream Anthropic / OpenAI key:

**Step 1** — Confirm the current key is configured.

```bash
curl "https://<host>/api/integrations/llm-keys?installationId=<id>" \
  -H "Authorization: Bearer $REVIEW_AGENT_DASHBOARD_TOKEN"
# Expect: "configured": true for the provider
```

**Step 2** — Call the rotate endpoint.

```bash
curl -X POST https://<host>/api/integrations/llm-keys/rotate \
  -H "Authorization: Bearer $REVIEW_AGENT_DASHBOARD_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"installationId": <id>, "provider": "anthropic"}'
# Expect HTTP 200: { "configured": true }
# Expect HTTP 404 if no key is stored yet
```

The server decrypts the current secret (KMS Decrypt → AES-GCM unseal), generates
a fresh data key + IV, re-encrypts under the same CMK, and persists the new
envelope. `rotated_at` is updated. An `audit_log` entry with `event:
"byok.key.rotate"` is written inside the same transaction.

**Step 3** — Verify.

```bash
curl "https://<host>/api/integrations/llm-keys?installationId=<id>" \
  -H "Authorization: Bearer $REVIEW_AGENT_DASHBOARD_TOKEN"
# Confirm "configured": true and check rotated_at in audit_log
```

**Step 4** — If rotating to a new CMK alias (e.g., annual CMK re-key), update
`REVIEW_AGENT_BYOK_KMS_KEY_ID` and redeploy workers before calling `/rotate` —
the server uses the env var as `kmsKeyId` for all new writes.

### Routine rotation (provider key, 90-day)

Per spec §8.7, Anthropic / OpenAI / Google keys should be rotated every 90 days
where the provider supports key rotation.

**Step 1** — Mint a new key in the provider console (Anthropic console, OpenAI
platform, etc.).

**Step 2** — Register the new key via upsert. This replaces the encrypted blob
in place:

```bash
curl -X POST https://<host>/api/integrations/llm-keys \
  -H "Authorization: Bearer $REVIEW_AGENT_DASHBOARD_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"installationId": <id>, "provider": "anthropic", "apiKey": "sk-ant-<new>"}'
```

**Step 3** — Verify that the worker can resolve the key by triggering a test
review (open a draft PR in the installation's org).

**Step 4** — Revoke the old key in the provider console. Do not revoke before
Step 3 passes — a failed verification with the old key revoked leaves the
installation without a working key.

---

## Leak / incident response

> **See also**: `docs/security/oncall.md` for SLO targets and alarm setup;
> `SECURITY.md` §8.6.1 for the general compromised-LLM-provider-key runbook.
> This section extends §8.6.1 with BYOK-specific blast-radius and invalidation
> steps.

### Detection signals

| Signal | Source | Urgency |
|---|---|---|
| Anomalous LLM API spend | Provider billing dashboard / cost alerts | Immediate |
| `cost.threshold_crossed{threshold="kill"}` metric | Prometheus / CloudWatch | Immediate |
| Anthropic 401 / 403 rate spike | `review_agent_llm_errors_total` metric | Immediate |
| Unexpected usage in provider console from unknown IPs | Provider usage logs | Investigate |
| `audit_log` entries for `byok.key.upsert` / `byok.key.rotate` from unexpected sources | pgaudit / `audit_log` table | Investigate |
| CloudTrail `kms:Decrypt` calls at unexpected volume or from unexpected IAM principals | CloudTrail | Investigate |

### Emergency rotation procedure (key suspected compromised)

**Target MTTR: < 15 minutes** (§8.6.1).

**Step 1 — Revoke the exposed key immediately.**

In the provider console, revoke / delete the compromised key before doing
anything else. This stops further unauthorized use regardless of what is in
the database.

- Anthropic: <https://console.anthropic.com/settings/keys> → Revoke.
- OpenAI: <https://platform.openai.com/api-keys> → Delete.
- Azure OpenAI: Azure Portal → Cognitive Services → Keys and Endpoint → Regenerate.
- Google AI Studio / Vertex: Google Cloud Console → APIs & Services → Credentials → Delete.

**Step 2 — Mint a new key in the provider console** and record it securely (e.g.,
in a password manager / secrets manager scratch entry). Do not commit it anywhere.

**Step 3 — Register the new key via upsert.**

```bash
curl -X POST https://<host>/api/integrations/llm-keys \
  -H "Authorization: Bearer $REVIEW_AGENT_DASHBOARD_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"installationId": <id>, "provider": "anthropic", "apiKey": "sk-ant-<new>"}'
```

The encrypted blob in `installation_secrets` is replaced; the old ciphertext
that referenced the revoked key is gone.

**Step 4 — Rotate the envelope (re-wrap with fresh data key).**

```bash
curl -X POST https://<host>/api/integrations/llm-keys/rotate \
  -H "Authorization: Bearer $REVIEW_AGENT_DASHBOARD_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"installationId": <id>, "provider": "anthropic"}'
```

This ensures the new key is wrapped under a fresh AES data key + IV, discarding
any relationship with prior cryptographic material.

**Step 5 — Restart workers** to flush any in-memory state.

```bash
# Lambda:
aws lambda update-function-code \
  --function-name review-agent-worker \
  --zip-file fileb://current.zip   # triggers a redeploy / env refresh
```

**Step 6 — Assess blast radius.**

Determine which PRs were reviewed using the compromised key during the exposure
window. BYOK keys are scoped per `(installation_id, provider)`, so the
authoritative table is `review_eval_event` — one row per `runReview`
invocation, recording the `provider` and `pr_number` actually used
(`packages/core/src/db/schema/review-eval-event.ts`).

```sql
-- Run inside withTenant(installationId) so RLS scopes rows to this
-- installation (the tenant_isolation policy enforces installation_id).
SELECT repo, pr_number, head_sha, model, created_at
FROM review_eval_event
WHERE provider = '<exposed_provider>'        -- e.g. 'anthropic'
  AND created_at >= '<exposure_start>'::timestamptz  -- suspected exposure window start
ORDER BY created_at DESC;

-- Check audit_log for any unexpected BYOK management events in the window.
-- audit_log uses `ts` (timestamp) and `hash` (chain hash) — there is no
-- `created_at` or `hmac` column (packages/core/src/db/schema/audit-log.ts).
SELECT event, installation_id, ts, hash
FROM audit_log
WHERE installation_id = <id>
  AND event LIKE 'byok.%'                      -- byok.key.upsert / .rotate / .delete
  AND ts >= '<exposure_start>'::timestamptz
ORDER BY ts DESC;
```

The diff content of those PRs was sent to the LLM provider API using the
compromised key and may have been accessible to whoever held the key. Assess
whether the reviewed diffs contained secrets, PII, or confidential data.

**Step 7 — Invalidate derived secrets.**

If the compromised key was used to authenticate to an LLM provider, consider
whether any context injected into prompts (PR diffs, file contents) needs to
be treated as potentially exposed. This is a business / compliance decision.

If the compromise extended to the database (e.g., `installation_secrets` row
was exfiltrated), the `wrapped_data_key` ciphertext is only as secure as the
KMS CMK. Verify CloudTrail for unexpected `kms:Decrypt` calls:

```bash
aws cloudtrail lookup-events \
  --lookup-attributes AttributeKey=EventName,AttributeValue=Decrypt \
  --start-time <exposure_start> \
  --end-time <now>
```

If unauthorized `kms:Decrypt` calls occurred, schedule the compromised CMK for
deletion (after re-keying all rows to a new CMK):

```bash
# Re-key all rows for the installation to a new CMK first.
# Then schedule the old CMK for deletion:
aws kms schedule-key-deletion \
  --key-id <old-cmk-arn> \
  --pending-window-in-days 7
```

**Step 8 — Notify stakeholders.**

Per typical regulatory norms (GDPR / CCPA), customer notification is required
within 72 hours of confirmed breach discovery. The customer-comms message is
separate from the internal post-mortem. Both should reference which runbook
section was followed and which PRs/diffs were in scope.

Internal post-mortem fields: timeline (UTC), detection source, MTTR, affected
installations, root cause, action items. See `docs/security/oncall.md` for the
full post-mortem format.

**Step 9 — Verify and close.**

```bash
# Confirm the new key is configured and operational:
curl "https://<host>/api/integrations/llm-keys?installationId=<id>" \
  -H "Authorization: Bearer $REVIEW_AGENT_DASHBOARD_TOKEN"

# Verify the audit-log hash chain is intact (§13.3). There is no dedicated
# verify command — `audit export` validates the chain internally and refuses
# to write if a segment is broken, so a successful export proves integrity.
review-agent audit export \
  --installation <id> \
  --since <exposure_start> \
  --output ./byok-incident-audit.jsonl.gz
```

The chain is a SHA-256 hash chain (`hash = sha256(prev_hash || row_payload)`,
spec §13.3), not a keyed HMAC; `audit export` replays it and aborts on any
break (see `packages/cli` `audit-export` — "refuses to write when the audit
chain segment is broken").

---

## Threat model

### Trust boundary — who can decrypt a BYOK key

| Principal | Access | Condition |
|---|---|---|
| Worker process (`review_agent_app` DB role) | Decrypt via KMS + RLS | Must hold the IAM role with `kms:Decrypt` on the CMK AND call `withTenant` for the correct `installation_id`. Two independent controls must both succeed. |
| Postgres superuser / `BYPASSRLS` role | Read `wrapped_data_key` ciphertext only | Bypasses RLS but still cannot decrypt without the KMS CMK. Ciphertext is opaque without CMK access. |
| KMS-authorized IAM principal (e.g., human operator with `kms:Decrypt`) | Decrypt the data key but not the customer API key directly | Would additionally need the `encrypted_secret`, `iv`, and `auth_tag` from the database. |
| Anyone with only Postgres dump | Nothing — ciphertext without CMK is indistinguishable from random |
| Anyone with only CMK access | Nothing — the CMK wraps a per-row data key; the ciphertext is in Postgres |

**Minimum breach scope**: an attacker must simultaneously hold (a) DB read access
(bypassing or satisfying RLS) and (b) KMS `Decrypt` access on the relevant CMK.
These are separate AWS/GCP IAM planes.

### RBAC gate on BYOK management endpoints (A8)

The BYOK management endpoints (`/api/integrations/llm-keys`) are currently
authenticated by the operator single-tenant bearer token (`REVIEW_AGENT_DASHBOARD_TOKEN`),
enforced by `bearerTokenAuth` middleware in `packages/server/src/api/middleware/auth.ts`.
This authorises writes to **any** `installationId` — there is no per-installation
ownership check in the current release.

A **fail-closed multi-tenant interlock** (`REVIEW_AGENT_MULTI_TENANT=true`) was
added in issue #132: when the flag is set, all four BYOK endpoints return `501`
before any `withTenant` call or DB write, making it structurally impossible to
ship per-installation IDOR in multi-tenant mode until per-installation authz lands.
See `docs/security/multi-tenant-authz.md`.

Per-installation RBAC (A8) — governing which operator token may manage which
installation's keys — is a planned enhancement. **When A8 lands, this section
will be updated to cross-link the A8 specification.** Until then, treat the
operator bearer token as holding admin-level access to all installations.

---

## Recovery — CMK loss

**If you lose the KMS CMK, every `installation_secrets` row for that CMK is
unrecoverable.** AES-256-GCM ciphertext without the data key is
indistinguishable from random bytes.

Mitigations:

- Enable AWS KMS automatic key rotation (annual) on the CMK. AWS retains prior
  key material internally so rotation is non-destructive.
- For DR: replicate the CMK to a secondary region via `kms:ReplicateKey`. The
  replica accepts the same key material.
- Never schedule a CMK for deletion without first re-keying every
  `installation_secrets` row to a successor CMK.
- Snapshot the `installation_secrets` table alongside RDS automated backups.
  Without the wrapped data key + IV + auth tag, a snapshot row is useless to
  anyone without CMK access.

---

## Reading at review time

The worker resolves the secret inside the per-job tenant transaction so RLS
bounds the lookup to the correct installation:

```ts
await withTenant(db, job.installationId, async (tx) => {
  const apiKey =
    process.env.ANTHROPIC_API_KEY ??  // single-tenant fast path
    (await store.read({ installationId: job.installationId, provider: 'anthropic' }));
  if (!apiKey) throw new Error('No API key configured');
  // build provider with apiKey, run review; key drops out of scope
});
```

Keep the secret in scope only for the duration of one LLM call. Do not cache
it at module level — that defeats the per-tenant isolation RLS enforces.

---

## Operator checklist

### Initial BYOK setup

- [ ] CMK created with annual key rotation enabled (`aws kms enable-key-rotation`).
- [ ] CMK alias created (`aws kms create-alias`) so re-key operations do not
      break config files.
- [ ] Worker IAM role grants `kms:Encrypt` + `kms:Decrypt` on the CMK ARN only
      — not `kms:*` on `*`.
- [ ] `REVIEW_AGENT_BYOK_KMS_KEY_ID` set to the CMK alias ARN in the worker env.
- [ ] BYOK key registered via dashboard (`/integrations/keys`) or
      `POST /api/integrations/llm-keys`.
- [ ] Configuration verified via `GET /api/integrations/llm-keys?installationId=<id>`
      — expect `"configured": true`.
- [ ] Test review triggered (open a draft PR) to confirm end-to-end decryption works.
- [ ] CMK replicated to a secondary region for DR.
- [ ] `REVIEW_AGENT_MULTI_TENANT=true` set if running in multi-tenant mode (enables
      fail-closed interlock — see `docs/security/multi-tenant-authz.md`).

### Routine rotation (quarterly envelope, 90-day provider key)

- [ ] Envelope rotation: `POST /api/integrations/llm-keys/rotate` for each
      `(installationId, provider)`. Verify `"configured": true` and `rotated_at`
      updated in `audit_log`.
- [ ] Provider key rotation: mint new key in provider console → upsert via
      `POST /api/integrations/llm-keys` with new key → verify test review works →
      revoke old key in provider console.
- [ ] If rotating to a new CMK: update `REVIEW_AGENT_BYOK_KMS_KEY_ID` and redeploy
      workers before calling `/rotate`.
- [ ] Audit-log hash chain verified after rotation (`review-agent audit export`
      — it validates the chain and refuses to write on a break; there is no
      dedicated verify command).

### Incident response

- [ ] Revoke compromised provider key in provider console (Step 1 above).
- [ ] Mint new key and upsert (Steps 2–3 above).
- [ ] Rotate envelope (Step 4 above).
- [ ] Restart workers (Step 5 above).
- [ ] Blast-radius SQL query run; affected PRs enumerated (Step 6 above).
- [ ] CloudTrail checked for unexpected `kms:Decrypt` calls (Step 7 above).
- [ ] Stakeholder notification sent within 72 hours (Step 8 above).
- [ ] Audit log chain verified; incident closed (Step 9 above).
- [ ] Post-mortem filed per `docs/security/oncall.md` format.
