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

function buildGithubStatus(env: IntegrationsEnv): GithubIntegration {
  const configured = isPresent(env.GITHUB_APP_ID);
  return {
    configured,
    appId: configured && env.GITHUB_APP_ID !== undefined ? maskId(env.GITHUB_APP_ID) : null,
    // Installation count requires a DB join not wired in this endpoint yet.
    // Operators extending this can pass the value via deps; for now 0 is
    // the honest "unknown" value rather than a fabricated non-zero.
    installationCount: 0,
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
};

export function createIntegrationsRouter(deps: IntegrationsDeps): Hono {
  const app = new Hono();

  app.get('/', (c) => {
    const response: IntegrationsResponse = {
      github: buildGithubStatus(deps.env),
      codecommit: buildCodecommitStatus(deps.env),
      llm: buildLlmStatus(deps.env),
    };
    return c.json(response, 200);
  });

  return app;
}
