import { ConfigError } from '@review-agent/core';
import { parse as parseYaml } from 'yaml';
import { isSupportedLanguage } from './languages.js';
import { type Config, ConfigSchema } from './schema.js';

export type EnvOverrides = {
  REVIEW_AGENT_LANGUAGE?: string;
  REVIEW_AGENT_PROVIDER?: string;
  REVIEW_AGENT_MODEL?: string;
  REVIEW_AGENT_MAX_USD_PER_PR?: string;
};

export function loadConfigFromYaml(yamlText: string): Config {
  let parsed: unknown;
  try {
    parsed = parseYaml(yamlText) ?? {};
  } catch (err) {
    throw new ConfigError('Invalid YAML in .review-agent.yml', { cause: err });
  }
  const result = ConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new ConfigError(
      `Invalid .review-agent.yml: ${result.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`,
      { cause: result.error },
    );
  }
  return result.data;
}

export function defaultConfig(): Config {
  return ConfigSchema.parse({});
}

export function mergeWithEnv(config: Config, env: EnvOverrides): Config {
  let next: Config = config;
  if (env.REVIEW_AGENT_LANGUAGE) {
    if (!isSupportedLanguage(env.REVIEW_AGENT_LANGUAGE)) {
      throw new ConfigError(
        `REVIEW_AGENT_LANGUAGE '${env.REVIEW_AGENT_LANGUAGE}' is not a supported language code.`,
      );
    }
    next = { ...next, language: env.REVIEW_AGENT_LANGUAGE };
  }
  if (env.REVIEW_AGENT_PROVIDER && env.REVIEW_AGENT_MODEL) {
    const parsed = ConfigSchema.shape.provider.safeParse({
      type: env.REVIEW_AGENT_PROVIDER,
      model: env.REVIEW_AGENT_MODEL,
    });
    if (!parsed.success) {
      throw new ConfigError(`REVIEW_AGENT_PROVIDER='${env.REVIEW_AGENT_PROVIDER}' invalid`, {
        cause: parsed.error,
      });
    }
    next = { ...next, provider: parsed.data };
  } else if (env.REVIEW_AGENT_PROVIDER || env.REVIEW_AGENT_MODEL) {
    throw new ConfigError('REVIEW_AGENT_PROVIDER and REVIEW_AGENT_MODEL must be set together.');
  }
  if (env.REVIEW_AGENT_MAX_USD_PER_PR) {
    const value = Number.parseFloat(env.REVIEW_AGENT_MAX_USD_PER_PR);
    if (!Number.isFinite(value) || value <= 0) {
      throw new ConfigError(
        `REVIEW_AGENT_MAX_USD_PER_PR='${env.REVIEW_AGENT_MAX_USD_PER_PR}' must be a positive number.`,
      );
    }
    next = { ...next, cost: { ...next.cost, max_usd_per_pr: value } };
  }
  return next;
}
