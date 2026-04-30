# @review-agent/db

Postgres connection pool and migration runner for `review-agent`.

The Drizzle schema definitions live in
[`@review-agent/core/db`](../core/src/db/schema/) so that `core` can stay
zero-I/O. This package adds the runtime driver (`postgres-js`), a thin
`createDbClient` factory, and a `runMigrations` wrapper around Drizzle's
migrator.

## Usage

```ts
import { createDbClient } from '@review-agent/db';

const { db, close } = createDbClient({ url: process.env.DATABASE_URL! });
// db: drizzle client typed against the @review-agent/core/db schema
await close();
```

## Migrations

Migrations are generated into `packages/core/src/db/migrations/`.

From the repo root:

```bash
pnpm --filter @review-agent/core build   # required: drizzle-kit reads dist/
pnpm db:generate                          # write a new migration after schema changes
pnpm db:migrate                           # apply pending migrations
pnpm db:studio                            # open Drizzle Studio
```

## Local dev DB

```bash
pnpm dev:up        # postgres + elasticmq via docker-compose.dev.yml
pnpm dev:db        # psql shell
pnpm dev:down
```

## License

Apache-2.0
