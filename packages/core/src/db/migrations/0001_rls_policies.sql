-- Grants — drizzle-kit handles the policies + ENABLE RLS for us, but
-- not the GRANTs the application role needs to actually reach the
-- tables it owns. Applied here so RLS is the only gate on tenant
-- access.
GRANT USAGE ON SCHEMA public TO "review_agent_app";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "review_agent_app";--> statement-breakpoint
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO "review_agent_app";--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "review_agent_app";--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO "review_agent_app";--> statement-breakpoint

ALTER TABLE "audit_log" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "cost_ledger" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "installation_cost_daily" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "installation_tokens" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "review_history" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "review_state" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "audit_log" AS PERMISSIVE FOR ALL TO "review_agent_app" USING ("audit_log"."installation_id"::text = current_setting('app.current_tenant', true)) WITH CHECK ("audit_log"."installation_id" IS NULL OR "audit_log"."installation_id"::text = current_setting('app.current_tenant', true));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "cost_ledger" AS PERMISSIVE FOR ALL TO "review_agent_app" USING ("cost_ledger"."installation_id"::text = current_setting('app.current_tenant', true)) WITH CHECK ("cost_ledger"."installation_id"::text = current_setting('app.current_tenant', true));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "installation_cost_daily" AS PERMISSIVE FOR ALL TO "review_agent_app" USING ("installation_cost_daily"."installation_id"::text = current_setting('app.current_tenant', true)) WITH CHECK ("installation_cost_daily"."installation_id"::text = current_setting('app.current_tenant', true));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "installation_tokens" AS PERMISSIVE FOR ALL TO "review_agent_app" USING ("installation_tokens"."installation_id"::text = current_setting('app.current_tenant', true)) WITH CHECK ("installation_tokens"."installation_id"::text = current_setting('app.current_tenant', true));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "review_history" AS PERMISSIVE FOR ALL TO "review_agent_app" USING ("review_history"."installation_id"::text = current_setting('app.current_tenant', true)) WITH CHECK ("review_history"."installation_id"::text = current_setting('app.current_tenant', true));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "review_state" AS PERMISSIVE FOR ALL TO "review_agent_app" USING ("review_state"."installation_id"::text = current_setting('app.current_tenant', true)) WITH CHECK ("review_state"."installation_id"::text = current_setting('app.current_tenant', true));