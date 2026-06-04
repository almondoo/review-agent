import { githubInstallations } from '@review-agent/core/db';
import type { DbClient } from '@review-agent/db';
import { count, isNull } from 'drizzle-orm';
import { Hono } from 'hono';
import type {
  CodeCommitIntegration,
  GithubIntegration,
  IntegrationsResponse,
  LlmIntegration,
} from './schemas.js';

/**
 * Env keys the integrations endpoint inspects. Passed in from `createApp`
 * so `core` stays zero-I/O and tests can inject arbitrary env snapshots.
 */
export type IntegrationsEnv = {
  readonly GITHUB_APP_ID?: string;
  /**
   * URL-safe GitHub App name used to build the install redirect URL
   * (`https://github.com/apps/<GITHUB_APP_SLUG>/installations/new`).
   * Distinct from GITHUB_APP_ID; optional — null when not set.
   */
  readonly GITHUB_APP_SLUG?: string;
  readonly AWS_REGION?: string;
  readonly REVIEW_AGENT_SNS_TOPIC_ARNS?: string;
  readonly REVIEW_AGENT_FEEDBACK_ALLOWLIST?: string;
  readonly ANTHROPIC_API_KEY?: string;
  readonly OPENAI_API_KEY?: string;
  readonly REVIEW_AGENT_PROVIDER?: string;
  readonly REVIEW_AGENT_MODEL?: string;
  readonly ANTHROPIC_MODEL?: string;
};

function isPresent(v: string | undefined): boolean {
  return v !== undefined && v.trim().length > 0;
}

/** Mask an ID value: show first 4 chars then `****`. */
function maskId(v: string): string {
  if (v.length <= 4) return '****';
  return `${v.slice(0, 4)}****`;
}

async function buildGithubStatus(
  env: IntegrationsEnv,
  db: DbClient | undefined,
): Promise<GithubIntegration> {
  const configured = isPresent(env.GITHUB_APP_ID);
  const appSlug = isPresent(env.GITHUB_APP_SLUG) ? (env.GITHUB_APP_SLUG as string) : null;

  let installationCount = 0;
  if (db !== undefined) {
    // Spec §8.2.3: the count must run via withTenant or a BYPASSRLS admin
    // role. When `db` is the regular review_agent_app connection without a
    // tenant GUC set, RLS returns 0 rows (fail-closed). Operators who need
    // the real cross-tenant total must inject a BYPASSRLS DbClient here.
    // The value is informational UI only; falling back to 0 is safe.
    try {
      const rows = await db
        .select({ value: count() })
        .from(githubInstallations)
        .where(isNull(githubInstallations.suspendedAt));
      installationCount = Number(rows[0]?.value ?? 0);
    } catch {
      // Fall back to 0 on any DB error (e.g., table not yet migrated,
      // connection failure). The count is informational only.
      installationCount = 0;
    }
  }

  return {
    configured,
    appId: configured && env.GITHUB_APP_ID !== undefined ? maskId(env.GITHUB_APP_ID) : null,
    appSlug,
    installationCount,
  };
}

function buildCodecommitStatus(env: IntegrationsEnv): CodeCommitIntegration {
  const regionOk = isPresent(env.AWS_REGION);
  const topicsOk = isPresent(env.REVIEW_AGENT_SNS_TOPIC_ARNS);
  const configured = regionOk && topicsOk;
  return {
    configured,
    region: env.AWS_REGION ?? null,
  };
}

function buildLlmStatus(env: IntegrationsEnv): LlmIntegration {
  const hasAnthropic = isPresent(env.ANTHROPIC_API_KEY);
  const hasOpenAi = isPresent(env.OPENAI_API_KEY);
  const configured = hasAnthropic || hasOpenAi;

  // Provider name: explicit env override > infer from which key is set > null
  let provider: string | null;
  if (isPresent(env.REVIEW_AGENT_PROVIDER)) {
    provider = env.REVIEW_AGENT_PROVIDER as string;
  } else if (hasAnthropic) {
    provider = 'anthropic';
  } else if (hasOpenAi) {
    provider = 'openai';
  } else {
    provider = null;
  }

  // Model resolution: REVIEW_AGENT_MODEL > ANTHROPIC_MODEL (when anthropic) > default for anthropic > null
  let model: string | null;
  if (isPresent(env.REVIEW_AGENT_MODEL)) {
    model = env.REVIEW_AGENT_MODEL as string;
  } else if (provider === 'anthropic' && isPresent(env.ANTHROPIC_MODEL)) {
    model = env.ANTHROPIC_MODEL as string;
  } else if (provider === 'anthropic') {
    model = 'claude-sonnet-4-5';
  } else {
    model = null;
  }

  return { configured, provider, model };
}

export type IntegrationsDeps = {
  readonly env: IntegrationsEnv;
  /**
   * Optional DB client. When provided, `installationCount` is fetched via a
   * real `COUNT(*)` from `github_installations WHERE suspended_at IS NULL`.
   * When absent (e.g., unit tests or CLI usage), `installationCount` returns 0.
   *
   * RLS note (spec §8.2.3): to receive a real cross-tenant total, inject a
   * DbClient that connects with a BYPASSRLS role. A standard review_agent_app
   * connection without a tenant GUC set will return 0 (fail-closed). A
   * withTenant-scoped connection will return 0 or 1 for that tenant only.
   */
  readonly db?: DbClient;
};

export function createIntegrationsRouter(deps: IntegrationsDeps): Hono {
  const app = new Hono();

  app.get('/', async (c) => {
    const response: IntegrationsResponse = {
      github: await buildGithubStatus(deps.env, deps.db),
      codecommit: buildCodecommitStatus(deps.env),
      llm: buildLlmStatus(deps.env),
    };
    return c.json(response, 200);
  });

  return app;
}
