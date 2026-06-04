/**
 * /api/integrations/llm-keys — BYOK LLM API key management.
 *
 * Authz model: installation-scoped RBAC (issue #161 §F).
 *   - GET (list)         : viewer  + membership
 *   - POST (upsert)      : admin   + membership
 *   - POST /rotate       : admin   + membership
 *   - DELETE             : admin   + membership
 *
 * When a JWT principal is present, installationAuthz runs per-route to
 * verify membership and minimum role before any withTenant call or DB write.
 * When no principal is present (legacy / shared-token), the original
 * multiTenantGuard behaviour is preserved: multiTenant=true → 501,
 * multiTenant=false → pass-through (single-operator implicit trust).
 *
 * Admin-tier audit events include actor=principal.id when JWT-authenticated.
 * Legacy deployments produce actor=null (backward compatible with existing
 * audit chain hash — the canonicalPayload function omits null actors).
 *
 * KMS key ID comes from server config (REVIEW_AGENT_BYOK_KMS_KEY_ID env var),
 * never from the request body.
 */
import { BYOK_PROVIDERS, type BYOKProvider, type KmsClient } from '@review-agent/core';
import { type AuditAppender, createByokStore, type DbClient, withTenant } from '@review-agent/db';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthEnv } from '../auth/types.js';
import { installationAuthz } from './middleware/installation-authz.js';

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
      /* v8 ignore next 3 -- regex guard above makes this unreachable */
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
   * (principal absent path) before any withTenant call or DB write.
   * See docs/security/multi-tenant-authz.md and issue #132.
   */
  readonly multiTenant?: boolean;
};

// ---------------------------------------------------------------------------
// Internal helper: extract installationId from GET query string
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export function createLlmKeysRouter(deps: LlmKeysDeps): Hono {
  const app = new Hono<AuthEnv>();
  const multiTenant = deps.multiTenant ?? false;

  /**
   * GET /api/integrations/llm-keys?installationId=<positive int>
   *
   * Returns one entry per BYOK_PROVIDERS member indicating whether a secret
   * exists for this installation. No secret material is returned.
   *
   * 200: { installationId: number, keys: Array<{ provider: BYOKProvider, configured: boolean }> }
   * Role required: viewer
   */
  app.get(
    '/',
    installationAuthz({
      required: 'viewer',
      getInstallationId: (c) => {
        const v = c.req.query('installationId');
        return v !== undefined && /^\d+$/.test(v) ? v : undefined;
      },
      multiTenant,
      db: deps.db,
    }),
    async (c) => {
      const rawQuery = { installationId: c.req.query('installationId') };
      const parsed = listQuerySchema.safeParse(rawQuery);
      if (!parsed.success) {
        return c.json({ error: 'validation_error', issues: parsed.error.issues }, 422);
      }
      const { installationId } = parsed.data;

      const keys = await withTenant(deps.db, installationId, async (tx) => {
        const store = createByokStore({ db: tx, kms: deps.kms });
        return store.listProviders(BigInt(installationId));
      });

      return c.json({ installationId, keys }, 200);
    },
  );

  /**
   * POST /api/integrations/llm-keys
   * Body: { installationId: number, provider: BYOKProvider, apiKey: string }
   *
   * Persists the API key via the byok-store KMS envelope. The plaintext key
   * is NEVER echoed back, NEVER logged, NEVER written directly to the DB.
   *
   * 200: { installationId: number, provider: BYOKProvider, configured: true }
   * Role required: admin
   */
  app.post(
    '/',
    installationAuthz({
      required: 'admin',
      getInstallationId: async (c) => {
        // Parse body to extract installationId for authz pre-check.
        // We read the body here; Hono buffers the raw body so the handler
        // can call c.req.json() again without re-reading the stream.
        try {
          const body = await c.req.json();
          const id = (body as Record<string, unknown>)?.installationId;
          return typeof id === 'number' && Number.isInteger(id) && id > 0 ? String(id) : undefined;
        } catch {
          return undefined;
        }
      },
      multiTenant,
      db: deps.db,
    }),
    async (c) => {
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
      const actor = c.get('principal')?.id ?? null;

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
        // apiKey is NEVER included. actor is null for legacy (no JWT principal).
        try {
          await deps.auditAppender({
            event: 'byok.key.upsert',
            installationId: BigInt(installationId),
            model: provider,
            ...(actor !== null ? { actor } : {}),
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
    },
  );

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
   * Role required: admin
   */
  app.post(
    '/rotate',
    installationAuthz({
      required: 'admin',
      getInstallationId: async (c) => {
        try {
          const body = await c.req.json();
          const id = (body as Record<string, unknown>)?.installationId;
          return typeof id === 'number' && Number.isInteger(id) && id > 0 ? String(id) : undefined;
        } catch {
          return undefined;
        }
      },
      multiTenant,
      db: deps.db,
    }),
    async (c) => {
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
      const actor = c.get('principal')?.id ?? null;

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
              ...(actor !== null ? { actor } : {}),
            });
          } catch (err) {
            auditError = err;
          }
        });
      } catch (err) {
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
    },
  );

  /**
   * DELETE /api/integrations/llm-keys
   * Body: { installationId: number, provider: BYOKProvider }
   *
   * Removes the BYOK secret row for the given installation + provider.
   * Idempotent: deleting a non-existent row succeeds.
   *
   * 200: { installationId: number, provider: BYOKProvider, configured: false }
   * Role required: admin
   */
  app.delete(
    '/',
    installationAuthz({
      required: 'admin',
      getInstallationId: async (c) => {
        try {
          const body = await c.req.json();
          const id = (body as Record<string, unknown>)?.installationId;
          return typeof id === 'number' && Number.isInteger(id) && id > 0 ? String(id) : undefined;
        } catch {
          return undefined;
        }
      },
      multiTenant,
      db: deps.db,
    }),
    async (c) => {
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
      const actor = c.get('principal')?.id ?? null;

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
            ...(actor !== null ? { actor } : {}),
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
    },
  );

  return app as unknown as Hono;
}
