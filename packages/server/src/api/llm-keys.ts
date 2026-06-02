/**
 * /api/integrations/llm-keys — BYOK LLM API key management.
 *
 * Authz model: operator-single-tenant (spec §22 / docs/security/feedback-command-authz.md).
 * The single dashboard bearer token (REVIEW_AGENT_DASHBOARD_TOKEN, enforced by
 * bearerTokenAuth in createApi) authorises writes to ANY installationId. There is
 * no per-installation ownership mapping; the operator is trusted for all tenants.
 * Per-installation authz is a deliberate future/separate concern — fail-closed
 * precedent applies (§22). RLS is still enforced via withTenant so the DB layer
 * bounds every query to the declared installationId.
 *
 * KMS key ID comes from server config (REVIEW_AGENT_BYOK_KMS_KEY_ID env var),
 * never from the request body.
 */
import { BYOK_PROVIDERS, type BYOKProvider } from '@review-agent/core';
import type { AuditAppender, ByokStore, DbClient, TenantTransaction } from '@review-agent/db';
import { withTenant } from '@review-agent/db';
import { Hono } from 'hono';
import { z } from 'zod';

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

const rotateBodySchema = z.object({
  installationId: installationIdSchema,
  provider: providerSchema,
});

const deleteBodySchema = z.object({
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
  readonly byokStore: ByokStore;
  readonly auditAppender: AuditAppender;
  /**
   * The AWS KMS CMK key ID / ARN used to wrap data keys.
   * Sourced from REVIEW_AGENT_BYOK_KMS_KEY_ID env var in production.
   * Must never be supplied by the request client.
   */
  readonly kmsKeyId: string;
};

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export function createLlmKeysRouter(deps: LlmKeysDeps): Hono {
  const app = new Hono();

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

    const keys = await withTenant(deps.db, installationId, async (_tx: TenantTransaction) => {
      // byokStore.listProviders queries installationSecrets inside the tenant
      // transaction so RLS bounds the SELECT to the matching installation_id.
      return deps.byokStore.listProviders(BigInt(installationId));
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

    await withTenant(deps.db, installationId, async (_tx: TenantTransaction) => {
      await deps.byokStore.upsert({
        installationId: BigInt(installationId),
        provider: provider as BYOKProvider,
        kmsKeyId: deps.kmsKeyId,
        secret: apiKey,
      });
    });

    // Audit the operation. provider goes in the `model` field (the only
    // available free-text field besides `event`). apiKey is NEVER included.
    await deps.auditAppender({
      event: 'byok.key.upsert',
      installationId: BigInt(installationId),
      model: provider,
    });

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
   */
  app.post('/rotate', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }

    const parsed = rotateBodySchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'validation_error', issues: parsed.error.issues }, 422);
    }
    const { installationId, provider } = parsed.data;

    await withTenant(deps.db, installationId, async (_tx: TenantTransaction) => {
      await deps.byokStore.rotate({
        installationId: BigInt(installationId),
        provider: provider as BYOKProvider,
        kmsKeyId: deps.kmsKeyId,
      });
    });

    await deps.auditAppender({
      event: 'byok.key.rotate',
      installationId: BigInt(installationId),
      model: provider,
    });

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

    const parsed = deleteBodySchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'validation_error', issues: parsed.error.issues }, 422);
    }
    const { installationId, provider } = parsed.data;

    await withTenant(deps.db, installationId, async (_tx: TenantTransaction) => {
      await deps.byokStore.remove({
        installationId: BigInt(installationId),
        provider: provider as BYOKProvider,
      });
    });

    await deps.auditAppender({
      event: 'byok.key.delete',
      installationId: BigInt(installationId),
      model: provider,
    });

    return c.json({ installationId, provider, configured: false as const }, 200);
  });

  return app;
}
