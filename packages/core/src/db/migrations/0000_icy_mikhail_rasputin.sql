CREATE ROLE "review_agent_app";--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"installation_id" bigint,
	"pr_id" text,
	"event" text NOT NULL,
	"model" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"prev_hash" text,
	"hash" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cost_ledger" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"installation_id" bigint NOT NULL,
	"job_id" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"call_phase" text NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cache_read_tokens" integer DEFAULT 0 NOT NULL,
	"cache_creation_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" double precision DEFAULT 0 NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "installation_cost_daily" (
	"installation_id" bigint NOT NULL,
	"date" text NOT NULL,
	"cost_usd" double precision DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "installation_cost_daily_installation_id_date_pk" PRIMARY KEY("installation_id","date")
);
--> statement-breakpoint
CREATE TABLE "installation_tokens" (
	"installation_id" bigint PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "review_history" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"installation_id" bigint NOT NULL,
	"repo" text NOT NULL,
	"fact_type" text NOT NULL,
	"fact_text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone DEFAULT now() + interval '180 days' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "review_state" (
	"id" text PRIMARY KEY NOT NULL,
	"installation_id" bigint NOT NULL,
	"pr_id" text NOT NULL,
	"head_sha" text NOT NULL,
	"state" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"delivery_id" text PRIMARY KEY NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX "audit_log_installation_idx" ON "audit_log" USING btree ("installation_id","ts");--> statement-breakpoint
CREATE INDEX "cost_ledger_job_idx" ON "cost_ledger" USING btree ("installation_id","job_id");--> statement-breakpoint
CREATE INDEX "cost_ledger_created_at_idx" ON "cost_ledger" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "review_history_installation_repo_idx" ON "review_history" USING btree ("installation_id","repo");--> statement-breakpoint
CREATE INDEX "review_history_expires_at_idx" ON "review_history" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "review_state_installation_pr_idx" ON "review_state" USING btree ("installation_id","pr_id");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_received_at_idx" ON "webhook_deliveries" USING btree ("received_at");