-- Migration 0014: OIDC principal support for issue #137 (SSO Phase A).
--
-- Extends `operator_principals` to allow OIDC-provisioned (SSO) principals
-- that have no local password. JIT provisioning creates a principal row on
-- the first successful OIDC login; membership/role is granted by an admin
-- via the CLI (same path as local users).
--
-- Changes:
--   1. `password_hash` — drop NOT NULL constraint (NULL = OIDC user, no password).
--   2. `provider`      — new text column, NOT NULL DEFAULT 'local'. Identifies
--                        the auth provider ('local' or an OIDC issuer string).
--   3. `external_id`   — new nullable text column. Holds the OIDC `sub` claim.
--   4. Partial unique index on (provider, external_id) WHERE external_id IS NOT NULL
--                        — prevents duplicate JIT-provisioned OIDC principals.
--
-- Backward compatibility:
--   - Existing local principals get provider='local', external_id=NULL (DEFAULT).
--   - password_hash stays populated for existing rows; the DROP NOT NULL only
--     affects future INSERT/UPDATE constraints — existing data is untouched.
--   - No RLS changes (intentional; these tables are control-plane auth).

ALTER TABLE "operator_principals"
  ALTER COLUMN "password_hash" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "operator_principals"
  ADD COLUMN IF NOT EXISTS "provider" text NOT NULL DEFAULT 'local';
--> statement-breakpoint
ALTER TABLE "operator_principals"
  ADD COLUMN IF NOT EXISTS "external_id" text;
--> statement-breakpoint
-- Partial unique index: (provider, external_id) unique only when external_id IS NOT NULL.
-- This allows multiple local principals (external_id=NULL) while enforcing uniqueness
-- across OIDC principals from the same provider.
CREATE UNIQUE INDEX IF NOT EXISTS "operator_principals_provider_external_id_uidx"
  ON "operator_principals" ("provider", "external_id")
  WHERE "external_id" IS NOT NULL;
