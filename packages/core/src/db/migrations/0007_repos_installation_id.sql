ALTER TABLE "repos" ADD COLUMN "installation_id" bigint REFERENCES "github_installations"("installation_id") ON DELETE set null;
