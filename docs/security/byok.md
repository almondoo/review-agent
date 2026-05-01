# BYOK — per-installation provider keys with KMS envelope encryption

This document covers how a multi-tenant `review-agent` deployment stores
each installation's LLM-provider API key on disk **encrypted at rest**,
how the worker decrypts it just-in-time at review time, and how to
rotate keys without touching application config.

Spec references: §8.5, §8.6.1, §8.7, §13.3, §16.1.

---

## When you need this

Single-tenant deployments (one GitHub installation = one Anthropic key
in env) do **not** need BYOK. Set `ANTHROPIC_API_KEY` and skip this
file.

Multi-tenant deployments (one webhook server, many installations, each
with their own provider key) **must** turn on BYOK. Otherwise the only
way to scope keys is one process per tenant — which doesn't scale.

The schema's `(installation_id, provider)` primary key also means a
single installation can BYOK to several providers at once (e.g.,
Anthropic for production repos, OpenAI for one experimental repo).

## Crypto, in one paragraph

For every secret we generate a **fresh 256-bit AES data key**, encrypt
the plaintext customer key with **AES-256-GCM** (96-bit IV, 128-bit
auth tag) under that data key, then hand the data key to **KMS** to be
wrapped under the operator's CMK. We persist `(wrapped_data_key,
encrypted_secret, iv, auth_tag, kms_key_id)`. The plaintext data key
is zeroed and dropped after one use.

To read: KMS `Decrypt(wrapped_data_key, kms_key_id) → data_key`, then
AES-GCM unseal with `(iv, auth_tag, encrypted_secret)`. Tag mismatch
or corruption throws — GCM authenticates, so silent decryption of
tampered ciphertext is impossible.

The plaintext customer key is **never logged**. The repository's
test suite asserts this with a `console.log` / `console.error` spy.

## Setting up the KMS CMK

### AWS

Create a customer-managed CMK with **annual key rotation** enabled
(per spec §8.7):

```bash
aws kms create-key \
  --description "review-agent BYOK envelope" \
  --key-usage ENCRYPT_DECRYPT \
  --customer-master-key-spec SYMMETRIC_DEFAULT \
  --tags TagKey=Application,TagValue=review-agent

# capture KeyId from the output:
CMK=arn:aws:kms:us-east-1:123456789012:key/<uuid>

aws kms enable-key-rotation --key-id $CMK
```

Add an alias so rotation / re-key operations don't drift through
config files:

```bash
aws kms create-alias --alias-name alias/review-agent-byok --target-key-id $CMK
```

The worker IAM role needs:

```json
{
  "Effect": "Allow",
  "Action": ["kms:Encrypt", "kms:Decrypt"],
  "Resource": "arn:aws:kms:us-east-1:123456789012:key/<uuid>"
}
```

Then point the worker at the alias:

```ts
import { createAwsKmsClient } from '@review-agent/kms-aws';
import { createByokStore } from '@review-agent/db';

const kms = createAwsKmsClient({ clientConfig: { region: 'us-east-1' } });
const store = createByokStore({ db, kms });

// Persist a new tenant's secret:
await withTenant(db, installationId, () =>
  store.upsert({
    installationId,
    provider: 'anthropic',
    kmsKeyId: 'arn:aws:kms:us-east-1:123456789012:alias/review-agent-byok',
    secret: secretFromUserOnboardingFlow,
  }),
);
```

### GCP / Azure

The shared `KmsClient` interface is intentionally cloud-agnostic. The
GCP and Azure implementations live in separate workspace packages
(`@review-agent/kms-gcp`, `@review-agent/kms-azure`) and ship as
follow-up issues — see the v0.3 roadmap. The schema, repository,
envelope helpers, and audit hooks here all work the moment those
clients land; they do not require any changes to existing rows.

## Reading at review time

The worker resolves the secret inside the per-job tenant transaction
so RLS bounds the lookup to the correct installation and KMS bounds
the decryption to a single CMK call:

```ts
await withTenant(db, job.installationId, async () => {
  const apiKey =
    process.env.ANTHROPIC_API_KEY ?? // single-tenant fast path
    (await store.read({ installationId: job.installationId, provider: 'anthropic' }));
  if (!apiKey) throw new Error('No API key configured');
  // build provider with apiKey, run review, drop it from scope
});
```

This pattern keeps the secret in memory only for the duration of one
LLM call. Don't stash it in a module-level cache — that defeats the
per-tenant isolation RLS just gave you.

## Rotation

`store.rotate()` re-wraps the existing secret under (possibly new)
CMK and emits a fresh data key + IV. The plaintext customer key
itself is unchanged — a "rotation" here means rotating *our* envelope,
not the upstream Anthropic / OpenAI key. Do that separately:

1. Mint a new key in the provider console.
2. `store.upsert({ ..., secret: newKey })` — replaces the encrypted
   blob in place.
3. Revoke the old key in the provider console.

For the *envelope* rotation (e.g., quarterly):

```ts
await withTenant(db, installationId, () =>
  store.rotate({
    installationId,
    provider: 'anthropic',
    kmsKeyId: 'arn:aws:kms:...alias/review-agent-byok-v2', // new CMK alias
  }),
);
```

Audit-log entry (see §13.3): emit a `secret.rotated` event with
`installation_id` + `provider` + `kms_key_id`. Do **not** log the
secret value.

## Recovery

**If you lose the KMS CMK, every `installation_secrets` row is
unrecoverable.** AES-256-GCM ciphertext without the data key is
indistinguishable from random.

Mitigations:

- Enable AWS KMS automatic key rotation (annual) on the CMK; AWS keeps
  prior versions internally so a rotation is non-destructive.
- For DR: replicate the CMK to a secondary region via
  `kms:ReplicateKey`. The replica accepts the same key material.
- Never schedule a CMK for deletion without first re-keying every
  `installation_secrets` row to a different CMK.
- Snapshot the `installation_secrets` table alongside RDS automated
  backups. Without the wrapped data key + IV + auth tag, the row is
  useless to anyone without CMK access.

## Threat model

| Threat | Mitigation |
|---|---|
| Postgres dump leaks tenant secrets | Ciphertext is opaque without CMK access. |
| Operator misconfigures RLS | `tenant_isolation` policy is the *only* row filter; `current_setting` returns NULL when unset, so missing tenant scope = zero rows. |
| Compromised application server reads cross-tenant rows | RLS plus the `kmsKeyId` per row mean the attacker needs both DB read and KMS Decrypt on every CMK to widen the blast radius. |
| Attacker tampers with stored ciphertext | GCM auth tag verifies; tampered rows throw at decrypt time, not silently round-trip. |
| Stale plaintext in Node memory | Buffer `.fill(0)` after use. JS GC timing means this is best-effort, not formally guaranteed. |

## Operational checklist

- [ ] CMK created with annual rotation enabled.
- [ ] CMK alias created (so re-key operations don't break config).
- [ ] Worker IAM role grants `kms:Encrypt` + `kms:Decrypt` on the CMK
      ARN only — not `kms:*` on `*`.
- [ ] Worker calls `withTenant(db, installationId, ...)` before every
      `store.read` / `store.upsert`.
- [ ] Audit log emits `secret.rotated` events on every rotation.
- [ ] Quarterly envelope rotation drill — `store.rotate(...)` over a
      sample tenant, verify decrypt still works.
- [ ] CMK replicated to a secondary region for DR.
- [ ] CMK deletion requires both: (a) re-key all rows to a successor
      CMK, (b) AWS Config rule that blocks `kms:ScheduleKeyDeletion`
      on the active CMK.
