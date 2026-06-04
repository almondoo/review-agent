/**
 * /api/integrations/llm-keys — BYOK LLM API key management.
 *
 * Authz model: operator-single-tenant (spec §22 / docs/security/feedback-command-authz.md).
 * The single dashboard bearer token (REVIEW_AGENT_DASHBOARD_TOKEN, enforced by
 * bearerTokenAuth in createApi) authorises writes to ANY installationId. There is
 * no per-installation ownership mapping; the operator is trusted for all tenants.
 * Per-installation authz is a deliberate future/separate concern — fail-closed
 * precedent applies (§22 / spec §8.2.4 open question b). RLS is still enforced
 * via withTenant so the DB layer bounds every query to the declared installationId.
 *
 * A fail-closed `REVIEW_AGENT_MULTI_TENANT` interlock now guards all four routes:
 * when set to true they return 501 before any withTenant call or DB write, making
 * it structurally impossible to ship the per-installation IDOR in multi-tenant
 * mode until per-installation authz lands. See
 * docs/security/multi-tenant-authz.md and issue #132.
 *
 * KMS key ID comes from server config (REVIEW_AGENT_BYOK_KMS_KEY_ID env var),
 * never from the request body.
 */
import { BYOK_PROVIDERS, type BYOKProvider, type KmsClient } from '@review-agent/core';
import { type AuditAppender, createByokStore, type DbClient, withTenant } from '@review-agent/db';
import { Hono } from 'hono';
import { z } from 'zod';
import { multiTenantGuard } from './middleware/multi-tenant-guard.js';

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const installationIdSchema = z.number().int().positive();

const providerSchema = z.enum(BYOK_PROVIDERS);

const upsertBodySchema = z.object({
  installationId: installationIdSchema,
  provider: providerSchema,
  /** The customer API key. Max 8192 chars to guard against oversized payloads. */
  apiKey: z.string().min(1).max(8192),
});

/** Shared schema for rotate and delete — both need only installationId + provider. */
const lookupBodySchema = z.object({
  installationId: installationIdSchema,
  provider: providerSchema,
});

const listQuerySchema = z.object({
  installationId: z
    .string()
    .regex(/^\d+$/, 'installationId must be a positive integer')
    .transform((v) => {
      const n = Number(v);
      if (!Number.isInteger(n) || n <= 0) {
        throw new Error('installationId must be a positive integer');
      }
      return n;
    }),
});

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

export type LlmKeysDeps = {
  readonly db: DbClient;
  /** KMS client used to wrap/unwrap BYOK data keys per request. */
  readonly kms: KmsClient;
  readonly auditAppender: AuditAppender;
  /**
   * The AWS KMS CMK key ID / ARN used to wrap data keys.
   * Sourced from REVIEW_AGENT_BYOK_KMS_KEY_ID env var in production.
   * Must never be supplied by the request client.
   */
  readonly kmsKeyId: string;
  /**
   * Fail-closed multi-tenant guard flag. When true all four routes return 501
   * before any withTenant call or DB write. See
   * docs/security/multi-tenant-authz.md and issue #132.
   */
  readonly multiTenant?: boolean;
};

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export function createLlmKeysRouter(deps: LlmKeysDeps): Hono {
  const app = new Hono();

  // Fail-closed guard: when REVIEW_AGENT_MULTI_TENANT=true all four routes
  // return 501 before any withTenant call or DB write (issue #132).
  app.use('*', multiTenantGuard({ multiTenant: deps.multiTenant ?? false }));

  /**
   * GET /api/integrations/llm-keys?installationId=<positive int>
   *
   * Returns one entry per BYOK_PROVIDERS member indicating whether a secret
   * exists for this installation. No secret material is returned.
   *
   * 200: { installationId: number, keys: Array<{ provider: BYOKProvider, configured: boolean }> }
   */
  app.get('/', async (c) => {
    const rawQuery = { installationId: c.req.query('installationId') };
    const parsed = listQuerySchema.safeParse(rawQuery);
    if (!parsed.success) {
      return c.json({ error: 'validation_error', issues: parsed.error.issues }, 422);
    }
    const { installationId } = parsed.data;

    const keys = await withTenant(deps.db, installationId, async (tx) => {
      // Build the store bound to tx so every query runs with the tenant GUC set.
      const store = createByokStore({ db: tx, kms: deps.kms });
      return store.listProviders(BigInt(installationId));
    });

    return c.json({ installationId, keys }, 200);
  });

  /**
   * POST /api/integrations/llm-keys
   * Body: { installationId: number, provider: BYOKProvider, apiKey: string }
   *
   * Persists the API key via the byok-store KMS envelope. The plaintext key
   * is NEVER echoed back, NEVER logged, NEVER written directly to the DB.
   *
   * 200: { installationId: number, provider: BYOKProvider, configured: true }
   */
  app.post('/', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }

    const parsed = upsertBodySchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'validation_error', issues: parsed.error.issues }, 422);
    }
    const { installationId, provider, apiKey } = parsed.data;

    let auditError: unknown;
    await withTenant(deps.db, installationId, async (tx) => {
      const store = createByokStore({ db: tx, kms: deps.kms });
      await store.upsert({
        installationId: BigInt(installationId),
        provider: provider as BYOKProvider,
        kmsKeyId: deps.kmsKeyId,
        secret: apiKey,
      });
      // Audit inside the same transaction so secret op + audit log are atomic.
      // Audit the operation. provider goes in the `model` field (the only
      // available free-text field besides `event`). apiKey is NEVER included.
      try {
        await deps.auditAppender({
          event: 'byok.key.upsert',
          installationId: BigInt(installationId),
          model: provider,
        });
      } catch (err) {
        // Best-effort audit: if the audit write fails, log server-side but do
        // not fail the HTTP response — the key was already persisted.
        auditError = err;
      }
    });

    if (auditError !== undefined) {
      process.stderr.write(
        `[review-agent] WARN: audit write failed for byok.key.upsert installationId=${installationId}: ${String(auditError)}\n`,
      );
    }

    return c.json({ installationId, provider, configured: true as const }, 200);
  });

  /**
   * POST /api/integrations/llm-keys/rotate
   * Body: { installationId: number, provider: BYOKProvider }
   *
   * Re-wraps the existing secret under the server KMS CMK with a fresh data
   * key + IV. The plaintext secret is read internally, re-encrypted, and the
   * data key is zeroed — no plaintext crosses the wire.
   *
   * 200: { installationId: number, provider: BYOKProvider, configured: true }
   * 404: { error: 'key_not_found' } — no existing key to rotate
   */
  app.post('/rotate', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }

    const parsed = lookupBodySchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'validation_error', issues: parsed.error.issues }, 422);
    }
    const { installationId, provider } = parsed.data;

    let auditError: unknown;
    let keyNotFound = false;
    try {
      await withTenant(deps.db, installationId, async (tx) => {
        const store = createByokStore({ db: tx, kms: deps.kms });
        await store.rotate({
          installationId: BigInt(installationId),
          provider: provider as BYOKProvider,
          kmsKeyId: deps.kmsKeyId,
        });
        try {
          await deps.auditAppender({
            event: 'byok.key.rotate',
            installationId: BigInt(installationId),
            model: provider,
          });
        } catch (err) {
          auditError = err;
        }
      });
    } catch (err) {
      // Distinguish "no row to rotate" (expected 404) from genuine server errors.
      if (err instanceof Error && err.message.includes('BYOK row missing')) {
        keyNotFound = true;
      } else {
        throw err;
      }
    }

    if (keyNotFound) {
      return c.json({ error: 'key_not_found' }, 404);
    }

    if (auditError !== undefined) {
      process.stderr.write(
        `[review-agent] WARN: audit write failed for byok.key.rotate installationId=${installationId}: ${String(auditError)}\n`,
      );
    }

    return c.json({ installationId, provider, configured: true as const }, 200);
  });

  /**
   * DELETE /api/integrations/llm-keys
   * Body: { installationId: number, provider: BYOKProvider }
   *
   * Removes the BYOK secret row for the given installation + provider.
   * Idempotent: deleting a non-existent row succeeds.
   *
   * 200: { installationId: number, provider: BYOKProvider, configured: false }
   */
  app.delete('/', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }

    const parsed = lookupBodySchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'validation_error', issues: parsed.error.issues }, 422);
    }
    const { installationId, provider } = parsed.data;

    let auditError: unknown;
    await withTenant(deps.db, installationId, async (tx) => {
      const store = createByokStore({ db: tx, kms: deps.kms });
      await store.remove({
        installationId: BigInt(installationId),
        provider: provider as BYOKProvider,
      });
      try {
        await deps.auditAppender({
          event: 'byok.key.delete',
          installationId: BigInt(installationId),
          model: provider,
        });
      } catch (err) {
        auditError = err;
      }
    });

    if (auditError !== undefined) {
      process.stderr.write(
        `[review-agent] WARN: audit write failed for byok.key.delete installationId=${installationId}: ${String(auditError)}\n`,
      );
    }

    return c.json({ installationId, provider, configured: false as const }, 200);
  });

  return app;
}
