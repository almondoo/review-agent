/**
 * Dev-only entry point for the Hono webhook server.
 *
 * Reads DATABASE_URL from the environment (or .env.local via --env-file),
 * wires up a noop in-memory queue (no SQS needed locally), and starts
 * the Node.js HTTP server.
 *
 * Usage:
 *   DATABASE_URL=postgres://... tsx watch src/dev.ts
 *   # or via the package script:
 *   pnpm --filter @review-agent/server dev
 */
import type { JobMessage, QueueClient } from '@review-agent/core';
import { createDbClient } from '@review-agent/db';
import { startNodeServer } from './node.js';

// ---------------------------------------------------------------------------
// Env validation
// ---------------------------------------------------------------------------

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  process.stderr.write(
    'review-agent [dev]: DATABASE_URL is required for dev. Set it in .env.local or your shell.\n' +
      '  Example: DATABASE_URL=postgres://review@localhost:5435/review_agent_dev\n',
  );
  process.exit(1);
}

const webhookSecret = process.env.REVIEW_AGENT_WEBHOOK_SECRET;
if (!webhookSecret) {
  process.stderr.write(
    'review-agent [dev]: REVIEW_AGENT_WEBHOOK_SECRET is not set — webhook signature verification will reject all deliveries.\n' +
      '  Set it to any string (e.g. "local-dev-secret") to accept test deliveries.\n',
  );
}

const dashboardToken = process.env.REVIEW_AGENT_DASHBOARD_TOKEN;
const dashboardTokenStatus = dashboardToken ? 'set' : 'unset';

const port = Number(process.env.PORT ?? 8080);

// ---------------------------------------------------------------------------
// DB
// ---------------------------------------------------------------------------

const { db } = createDbClient({ url: databaseUrl });

// ---------------------------------------------------------------------------
// Noop queue — no SQS required in dev
// ---------------------------------------------------------------------------

const noopQueue: QueueClient = {
  async enqueue(job: JobMessage): Promise<{ messageId: string }> {
    process.stdout.write(
      `review-agent [dev] queue.enqueue noop — kind: ${job.triggeredBy}, jobId: ${job.jobId}\n`,
    );
    return { messageId: `dev-${Date.now()}` };
  },
  async dequeue(): Promise<void> {
    // No-op: worker polling is not available in dev mode.
  },
};

// ---------------------------------------------------------------------------
// Startup banner
// ---------------------------------------------------------------------------

// Parse just the host portion of the DATABASE_URL for display (never log credentials).
function dbHostFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}:${parsed.port || 5432}${parsed.pathname}`;
  } catch {
    return '<unparseable>';
  }
}

process.stdout.write(
  `review-agent [dev] starting\n` +
    `  port:            ${port}\n` +
    `  db host:         ${dbHostFromUrl(databaseUrl)}\n` +
    `  dashboard token: ${dashboardTokenStatus}\n` +
    `  webhook secret:  ${webhookSecret ? 'set' : 'unset'}\n`,
);

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------

startNodeServer({
  db,
  queue: noopQueue,
  webhookSecret: webhookSecret ?? '',
  port,
  ...(dashboardToken !== undefined ? { api: { dashboardToken } } : {}),
});
