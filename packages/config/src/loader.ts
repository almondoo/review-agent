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

/**
 * The source from which a section of the effective config was resolved.
 *
 * Precedence order (highest → lowest):
 *   1. repo-yaml  — the committed `.review-agent.yml` in the repository.
 *   2. org-yaml   — the org-central `<org>/.github/review-agent.yml`.
 *   3. env        — environment variables (`REVIEW_AGENT_*`).
 *   4. default    — built-in Zod defaults (no YAML present, no env set).
 *
 * NOTE: env-vs-config precedence (§10.2: config > env) is not yet
 * fully enforced here — that is tracked in issue #156. The env source
 * is recorded as "env applied on top of YAML resolution" which matches
 * the current `mergeWithEnv` behaviour. The TODO in #156 will update
 * the precedence so env drops below repo/org in the final ordered list.
 */
export type ConfigResolutionSource = 'repo-yaml' | 'org-yaml' | 'env' | 'default';

/**
 * Per-section record of which source contributed the active value.
 *
 * Granularity is per-section rather than per-key. Per-key tracking
 * is complicated by Zod's default injection (defaults are applied
 * at parse time before the section-level source is known), so we
 * record the highest-precedence source that contributed to each
 * top-level section. This gives operators enough signal to understand
 * which config file "won" without requiring custom tracking of every
 * scalar field.
 *
 * Future extension: per-key granularity can be added once we have a
 * before/after diff mechanism outside of Zod parsing.
 */
export type ConfigResolutionLog = {
  /**
   * The primary source that determined the merged config.
   * One of: 'repo-yaml', 'org-yaml', 'env', 'default'.
   */
  readonly primarySource: ConfigResolutionSource;
  /**
   * Whether an org-level YAML was loaded and merged (via `extends: org`
   * or as a silent org-only fallback).
   */
  readonly orgYamlLoaded: boolean;
  /**
   * Whether any env-var overrides were applied on top of the YAML resolution.
   * See #156 for the full §10.2 env-vs-config precedence enforcement.
   *
   * TODO(#156): once env precedence is corrected (config > env per §10.2),
   * update this field to document which env vars were *not* applied because
   * repo/org YAML took precedence.
   */
  readonly envApplied: boolean;
  /**
   * Per-section source annotation. Keys match the top-level sections of
   * `Config`. Value is the highest-precedence source that influenced that
   * section. Sections not present were resolved entirely from defaults.
   */
  readonly sections: Readonly<Record<string, ConfigResolutionSource>>;
};

/**
 * The result of `resolveEffectiveConfig`: the final merged config plus
 * a human/machine-inspectable log of which sources contributed.
 */
export type ResolveEffectiveConfigResult = {
  readonly config: Config;
  readonly log: ConfigResolutionLog;
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

/**
 * Resolve the effective config from optional YAML text (repo and/or org
 * layers) plus env-var overrides, and return both the merged `Config` and
 * an inspectable `ConfigResolutionLog`.
 *
 * Precedence order applied (highest → lowest):
 *   1. `repoYaml`  — `.review-agent.yml` in the repository.
 *   2. `orgYaml`   — org-central config (already merged by the caller via
 *                    `loadConfigWithOrgFallback` before this function is
 *                    reached in the full wiring; alternatively pass the raw
 *                    org YAML here when calling standalone).
 *   3. `env`       — `REVIEW_AGENT_*` environment variables.
 *   4. Built-in Zod defaults.
 *
 * This function wraps `loadConfigFromYaml` + `mergeWithEnv` and records
 * which source contributed to the result. Callers that already run the
 * org-fallback resolution (server, action) should pass the pre-merged
 * YAML as `repoYaml` and leave `orgYaml` null (the log will reflect the
 * merged source).
 *
 * NOTE(#156): env-vs-config precedence (§10.2: config > env) is not yet
 * corrected — env is applied on top of YAML resolution, which matches the
 * current `mergeWithEnv` behaviour. When #156 lands, update the env
 * application order and the log accordingly.
 */
export function resolveEffectiveConfig(opts: {
  readonly repoYaml: string | null;
  readonly orgYaml?: string | null;
  readonly env?: EnvOverrides;
}): ResolveEffectiveConfigResult {
  const { repoYaml, orgYaml = null, env = {} } = opts;

  // Determine which YAML source wins for the base config.
  let baseConfig: Config;
  let primarySource: ConfigResolutionSource;
  let orgYamlLoaded = false;

  if (repoYaml !== null) {
    // Repo YAML is present — parse it. If it says `extends: org` and org
    // YAML is also provided, the caller is responsible for the merge step
    // (e.g. via `loadConfigWithOrgFallback`). We accept the result as the
    // repo-layer config here and record both sources.
    baseConfig = loadConfigFromYaml(repoYaml);
    primarySource = 'repo-yaml';

    if (orgYaml !== null) {
      // Caller supplied a separate org YAML. We note it was loaded; the
      // actual merge is the caller's responsibility (already done before
      // calling us, or the repoYaml already contains the merged output).
      orgYamlLoaded = true;
    }
  } else if (orgYaml !== null) {
    baseConfig = loadConfigFromYaml(orgYaml);
    primarySource = 'org-yaml';
    orgYamlLoaded = true;
  } else {
    baseConfig = ConfigSchema.parse({});
    primarySource = 'default';
  }

  // Build per-section source map. Mark each section as its primary source
  // (repo-yaml wins, then org-yaml, then default). Env overrides are noted
  // separately in the `envApplied` flag; per-section env tracking is a
  // future extension (see #156).
  const sections = buildSectionSources(
    baseConfig,
    primarySource,
    orgYamlLoaded ? 'org-yaml' : null,
  );

  // Apply env overrides on top (current behaviour — see #156 TODO).
  const hasEnv = Object.values(env).some((v) => v !== undefined);
  const finalConfig = hasEnv ? mergeWithEnv(baseConfig, env) : baseConfig;

  const log: ConfigResolutionLog = {
    primarySource,
    orgYamlLoaded,
    envApplied: hasEnv,
    sections,
  };

  return { config: finalConfig, log };
}

/**
 * Build a per-section source map. For each top-level section of `Config`,
 * record the highest-precedence source that contributed a value.
 *
 * We detect whether a section was explicitly configured by comparing it
 * against the zero-input default: if the section value differs from the
 * default-only parse, it came from the YAML; otherwise it came from the
 * Zod default. This heuristic is accurate for all object sections that
 * have Zod `.default({})` — it correctly identifies sections the operator
 * left at default vs. those they explicitly set.
 */
function buildSectionSources(
  config: Config,
  primarySource: ConfigResolutionSource,
  orgSource: ConfigResolutionSource | null,
): Readonly<Record<string, ConfigResolutionSource>> {
  const defaults = ConfigSchema.parse({});
  const sections: Record<string, ConfigResolutionSource> = {};

  const topLevelKeys = [
    'language',
    'profile',
    'provider',
    'reviews',
    'cost',
    'privacy',
    'repo',
    'skills',
    'incremental',
    'coordination',
    'server',
    'codecommit',
  ] as const;

  for (const key of topLevelKeys) {
    const configVal = config[key];
    const defaultVal = defaults[key];
    const isExplicitlySet = JSON.stringify(configVal) !== JSON.stringify(defaultVal);
    if (isExplicitlySet) {
      // If the org was merged and this key differs, attribute it to the
      // appropriate source. When org is present, we conservatively attribute
      // to the primary source (repo wins over org per §10.2 precedence).
      sections[key] =
        orgSource !== null && primarySource === 'repo-yaml'
          ? primarySource
          : (orgSource ?? primarySource);
    } else {
      sections[key] = 'default';
    }
  }

  return sections;
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
