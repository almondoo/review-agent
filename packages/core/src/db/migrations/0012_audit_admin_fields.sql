-- Migration 0012: audit_log admin fields for issue #136 (admin mutation auditing).
--
-- Adds:
--   1. `audit_log.resource_type` — nullable text; the kind of resource mutated
--      (e.g. 'repo', 'principal', 'membership', 'github_installation').
--   2. `audit_log.resource_id`   — nullable text; the resource identifier
--      (e.g. repo UUID, principal ID, composite key).
--
-- Both columns are nullable for backward compatibility. Existing rows remain
-- NULL, which is backward compatible with the HMAC chain: canonicalPayload
-- omits these fields when NULL, so existing hashes continue to verify
-- correctly without any data migration.

ALTER TABLE "audit_log"
  ADD COLUMN IF NOT EXISTS "resource_type" text;
--> statement-breakpoint
ALTER TABLE "audit_log"
  ADD COLUMN IF NOT EXISTS "resource_id" text;
