CREATE TABLE "github_installations" (
	"installation_id" bigint PRIMARY KEY NOT NULL,
	"account_login" text NOT NULL,
	"account_type" text NOT NULL,
	"app_id" bigint NOT NULL,
	"setup_action" text NOT NULL,
	"suspended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "github_installations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "github_installations" AS PERMISSIVE FOR ALL TO "review_agent_app" USING ("github_installations"."installation_id"::text = current_setting('app.current_tenant', true)) WITH CHECK ("github_installations"."installation_id"::text = current_setting('app.current_tenant', true));
