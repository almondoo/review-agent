-- Migration 0011: dashboard authentication & RBAC tables for issue #161 (Phase 1).
--
-- Adds:
--   1. `operator_principals`    — dashboard login accounts (username + scrypt hash + JWT token_version).
--   2. `installation_memberships` — maps principals to GitHub App installations with a role
--                                   (viewer | editor | admin).
--   3. `audit_log.actor`        — nullable text column; existing rows are NULL (backward compatible).
--
-- RLS is intentionally OMITTED on `operator_principals` and `installation_memberships`.
-- These tables are the control-plane authentication / authorisation tables. Queries against
-- them must run before `app.current_tenant` is set (i.e., before `withTenant`). Attaching a
-- tenant-scoped RLS policy would make them unreadable at login time. Access is restricted at
-- the application layer using a BYPASSRLS admin role or a direct DB connection.

CREATE TABLE IF NOT EXISTS "operator_principals" (
  "id" text PRIMARY KEY NOT NULL,
  "username" text NOT NULL,
  "password_hash" text NOT NULL,
  "token_version" integer DEFAULT 1 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "operator_principals_username_unique" UNIQUE ("username")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "installation_memberships" (
  -- principal_id: references operator_principals(id), cascades on delete.
  "principal_id" text NOT NULL,
  -- installation_id: references github_installations(installation_id), cascades on delete.
  -- Role values: 'viewer' | 'editor' | 'admin'. Validated at application layer.
  "installation_id" bigint NOT NULL,
  "role" text DEFAULT 'viewer' NOT NULL,
  "granted_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "installation_memberships_pkey" PRIMARY KEY ("principal_id", "installation_id")
);
--> statement-breakpoint
ALTER TABLE "installation_memberships"
  ADD CONSTRAINT "installation_memberships_principal_id_fk"
  FOREIGN KEY ("principal_id")
  REFERENCES "operator_principals" ("id")
  ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "installation_memberships"
  ADD CONSTRAINT "installation_memberships_installation_id_fk"
  FOREIGN KEY ("installation_id")
  REFERENCES "github_installations" ("installation_id")
  ON DELETE CASCADE;
--> statement-breakpoint
-- Index for principal_id lookups (e.g. "fetch all installations for this principal").
CREATE INDEX IF NOT EXISTS "installation_memberships_principal_id_idx"
  ON "installation_memberships" ("principal_id");
--> statement-breakpoint
-- Add nullable actor column to audit_log.
-- Existing rows remain NULL, which is backward compatible with the HMAC chain:
-- canonicalPayload omits the actor field when it is NULL, so existing hashes
-- continue to verify correctly without any data migration.
ALTER TABLE "audit_log"
  ADD COLUMN IF NOT EXISTS "actor" text;
