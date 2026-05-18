CREATE TABLE "review_eval_event" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"installation_id" bigint NOT NULL,
	"job_id" text NOT NULL,
	"repo" text NOT NULL,
	"pr_number" integer NOT NULL,
	"head_sha" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"comment_count" integer DEFAULT 0 NOT NULL,
	"severity_dist" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"confidence_dist" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"dropped_duplicates" integer DEFAULT 0 NOT NULL,
	"dropped_by_feedback" integer DEFAULT 0 NOT NULL,
	"tool_calls" integer DEFAULT 0 NOT NULL,
	"latency_ms" integer DEFAULT 0 NOT NULL,
	"cost_usd" double precision DEFAULT 0 NOT NULL,
	"tokens_input" integer DEFAULT 0 NOT NULL,
	"tokens_output" integer DEFAULT 0 NOT NULL,
	"abort_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cost_ledger" ADD COLUMN "latency_ms" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "review_eval_event_installation_repo_idx" ON "review_eval_event" USING btree ("installation_id","repo");--> statement-breakpoint
CREATE INDEX "review_eval_event_created_at_idx" ON "review_eval_event" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "review_eval_event_job_idx" ON "review_eval_event" USING btree ("installation_id","job_id");--> statement-breakpoint
ALTER TABLE "review_eval_event" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "review_eval_event" AS PERMISSIVE FOR ALL TO "review_agent_app" USING ("review_eval_event"."installation_id"::text = current_setting('app.current_tenant', true)) WITH CHECK ("review_eval_event"."installation_id"::text = current_setting('app.current_tenant', true));
