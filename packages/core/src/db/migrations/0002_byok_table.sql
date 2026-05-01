CREATE TABLE "installation_secrets" (
	"installation_id" bigint NOT NULL,
	"provider" text NOT NULL,
	"kms_key_id" text NOT NULL,
	"wrapped_data_key" "bytea" NOT NULL,
	"encrypted_secret" "bytea" NOT NULL,
	"iv" "bytea" NOT NULL,
	"auth_tag" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rotated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "installation_secrets_installation_id_provider_pk" PRIMARY KEY("installation_id","provider")
);
--> statement-breakpoint
ALTER TABLE "installation_secrets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "installation_secrets" AS PERMISSIVE FOR ALL TO "review_agent_app" USING ("installation_secrets"."installation_id"::text = current_setting('app.current_tenant', true)) WITH CHECK ("installation_secrets"."installation_id"::text = current_setting('app.current_tenant', true));