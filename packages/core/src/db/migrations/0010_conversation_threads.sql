-- Migration 0010: add `conversation_threads` table for #149 inline-reply conversation tracking.
--
-- Tracks per-thread turn counts so the agent can enforce `max_conversation_turns`
-- and post a single "conversation limit reached" note when exceeded.
--
-- Primary key: `(installation_id, repo, pr_number, root_comment_id)` modelled via
-- a unique index `conversation_threads_key_idx`; the table has a bigserial `id`
-- surrogate PK for upsert convenience.
--
-- RLS mirrors every other tenant-scoped table (§16.1): `tenant_isolation` policy
-- keyed on `app.current_tenant` GUC.

CREATE TABLE IF NOT EXISTS "conversation_threads" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "installation_id" bigint NOT NULL,
  "repo" text NOT NULL,
  "pr_number" integer NOT NULL,
  "root_comment_id" text NOT NULL,
  "turn_count" integer DEFAULT 0 NOT NULL,
  "last_turn_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "conversation_threads" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "conversation_threads"
  ADD CONSTRAINT "conversation_threads_key_uniq"
  UNIQUE ("installation_id", "repo", "pr_number", "root_comment_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conversation_threads_last_turn_at_idx"
  ON "conversation_threads" ("last_turn_at");
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "conversation_threads"
  AS PERMISSIVE FOR ALL
  TO "review_agent_app"
  USING ("installation_id"::text = current_setting('app.current_tenant', true))
  WITH CHECK ("installation_id"::text = current_setting('app.current_tenant', true));
