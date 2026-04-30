import { isSupportedLanguage, type SupportedLanguage } from '@review-agent/config';

export type ActionInputs = {
  readonly githubToken: string;
  readonly anthropicApiKey: string | null;
  readonly language: SupportedLanguage;
  readonly configPath: string;
  readonly costCapUsd: number;
};

export type RawInputs = {
  readonly 'github-token'?: string;
  readonly 'anthropic-api-key'?: string;
  readonly language?: string;
  readonly 'config-path'?: string;
  readonly 'cost-cap-usd'?: string;
};

export function parseInputs(raw: RawInputs): ActionInputs {
  const githubToken = raw['github-token']?.trim() ?? '';
  if (!githubToken) {
    throw new Error('Input github-token is required.');
  }
  const language = raw.language?.trim() || 'en-US';
  if (!isSupportedLanguage(language)) {
    throw new Error(`Input language '${language}' is not a supported code.`);
  }
  const costCapRaw = raw['cost-cap-usd']?.trim() || '1.0';
  const costCapUsd = Number.parseFloat(costCapRaw);
  if (!Number.isFinite(costCapUsd) || costCapUsd <= 0) {
    throw new Error(`Input cost-cap-usd must be a positive number; got '${costCapRaw}'.`);
  }
  return {
    githubToken,
    anthropicApiKey: raw['anthropic-api-key']?.trim() || null,
    language,
    configPath: raw['config-path']?.trim() || '.review-agent.yml',
    costCapUsd,
  };
}
