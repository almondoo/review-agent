-- Loaded by docker-compose.dev.yml on initial postgres bring-up.
-- Creates the application role used by review-agent. RLS policies are
-- attached in v0.3 #01; for now the role exists but no policies enforce
-- tenant isolation.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'review_agent_app') THEN
    CREATE ROLE review_agent_app NOLOGIN;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO review_agent_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO review_agent_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO review_agent_app;
