import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  // Point at compiled output. Run `pnpm --filter @review-agent/core build`
  // before `pnpm db:generate` / `pnpm db:push`. This avoids drizzle-kit's
  // CJS loader choking on .js extensions in NodeNext source.
  schema: './dist/db/schema/index.js',
  out: './src/db/migrations',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://review:review@localhost:5432/review_agent',
  },
  verbose: true,
  strict: true,
});
