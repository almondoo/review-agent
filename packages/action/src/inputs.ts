import { isSupportedLanguage, type SupportedLanguage } from '@review-agent/config';

export type ActionInputs = {
  readonly githubToken: string;
  readonly anthropicApiKey: string | null;
  readonly language: SupportedLanguage;
  readonly configPath: string;
  readonly costCapUsd: number;
  /**
   * Number of retries on top of the first attempt for the state-comment
   * write and the inline-review write. 0 = fail-fast (single attempt
   * with no retry); 3 (default) = up to 4 total attempts with
   * exp-backoff 1s/3s/9s on transient failures; 5 = up to 6 total
   * attempts. Range: 0–5. Spec §12 + audit D finding #1.
   */
  readonly stateWriteRetries: number;
};

export type RawInputs = {
  readonly 'github-token'?: string;
  readonly 'anthropic-api-key'?: string;
  readonly language?: string;
  readonly 'config-path'?: string;
  readonly 'cost-cap-usd'?: string;
  readonly 'state-write-retries'?: string;
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
  const retriesRaw = raw['state-write-retries']?.trim() || '3';
  const stateWriteRetries = Number.parseInt(retriesRaw, 10);
  if (
    !Number.isFinite(stateWriteRetries) ||
    !Number.isInteger(stateWriteRetries) ||
    stateWriteRetries < 0 ||
    stateWriteRetries > 5 ||
    !/^\d+$/.test(retriesRaw)
  ) {
    throw new Error(`Input state-write-retries must be an integer in [0, 5]; got '${retriesRaw}'.`);
  }
  return {
    githubToken,
    anthropicApiKey: raw['anthropic-api-key']?.trim() || null,
    language,
    configPath: raw['config-path']?.trim() || '.review-agent.yml',
    costCapUsd,
    stateWriteRetries,
  };
}
