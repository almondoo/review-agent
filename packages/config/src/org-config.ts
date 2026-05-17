import { ConfigError } from '@review-agent/core';
import { loadConfigFromYaml } from './loader.js';
import { type Config, type ConfigInput, ConfigSchema } from './schema.js';

// §10.2 precedence layer 3 — organization-wide default config that
// repos either silently inherit (when their `.review-agent.yml` is
// missing) or explicitly compose with via `extends: org`.

export type OrgConfigFetch = (owner: string) => Promise<string | null>;

export type OrgConfigCacheOpts = {
  readonly ttlMs?: number;
  readonly now?: () => number;
};

const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes per acceptance criteria

type CacheEntry = { readonly text: string | null; readonly expires: number };

export type OrgConfigCache = {
  get(owner: string): Promise<string | null>;
  invalidate(owner?: string): void;
};

// Per-installation, in-process TTL cache for the raw YAML text. The
// fetcher is the pluggable I/O boundary — tests pass a fake; the
// production wiring uses Octokit's `repos.getContent`.
export function createOrgConfigCache(
  fetch: OrgConfigFetch,
  opts: OrgConfigCacheOpts = {},
): OrgConfigCache {
  const ttl = opts.ttlMs ?? DEFAULT_TTL_MS;
  const now = opts.now ?? (() => Date.now());
  const entries = new Map<string, CacheEntry>();

  return {
    async get(owner: string): Promise<string | null> {
      const cached = entries.get(owner);
      if (cached && cached.expires > now()) return cached.text;
      const text = await fetch(owner);
      entries.set(owner, { text, expires: now() + ttl });
      return text;
    },
    invalidate(owner?: string): void {
      if (owner === undefined) entries.clear();
      else entries.delete(owner);
    },
  };
}

export type LoadConfigWithOrgInput = {
  readonly owner: string;
  /** Raw YAML text of the per-repo `.review-agent.yml`, or null when absent. */
  readonly repoYaml: string | null;
  readonly orgConfigCache: OrgConfigCache;
};

export type LoadConfigWithOrgResult = {
  readonly config: Config;
  /** Where the effective config came from (helpful for telemetry). */
  readonly source: 'repo+org' | 'repo' | 'org' | 'defaults';
};

// Resolves the effective config per the §10.2 precedence chain:
//
//   1. repo present + `extends: org`           → merged(org, repo)
//   2. repo present (no extends)               → repo
//   3. repo absent + org present (silent)      → org
//   4. neither                                 → defaults
//
// List fields (skills, path_filters, ignore_authors, ...) are
// CONCATENATED on merge (org first, then repo). Scalar / object
// fields are overridden by repo. This mirrors the conventional
// "extend, don't replace" intuition for shared lint configs.
export async function loadConfigWithOrgFallback(
  input: LoadConfigWithOrgInput,
): Promise<LoadConfigWithOrgResult> {
  const repoConfig = input.repoYaml === null ? null : loadConfigFromYaml(input.repoYaml);
  const wantsExtends = repoConfig?.extends === 'org';

  if (repoConfig && !wantsExtends) {
    return { config: repoConfig, source: 'repo' };
  }

  const orgYaml = await input.orgConfigCache.get(input.owner);
  const orgConfig = orgYaml === null ? null : loadConfigFromYaml(orgYaml);

  if (repoConfig && wantsExtends) {
    if (!orgConfig) {
      // The repo opted in but org has no config. Fail loudly so the
      // operator notices the misconfiguration.
      throw new ConfigError(
        `${input.owner}/.github/review-agent.yml not found, but ${input.owner}'s repo config requested extends: org`,
      );
    }
    return { config: mergeOrgIntoRepo(orgConfig, repoConfig), source: 'repo+org' };
  }

  if (orgConfig) return { config: orgConfig, source: 'org' };
  return { config: ConfigSchema.parse({}), source: 'defaults' };
}

// repo wins on scalars / nested objects; lists are concatenated
// (org first, then repo). Duplicate skill names / path patterns are
// expected — downstream code (skill loader, glob compiler) handles
// duplicates.
export function mergeOrgIntoRepo(orgConfig: Config, repoConfig: Config): Config {
  const merged: ConfigInput = {
    extends: null,
    language: repoConfig.language,
    profile: repoConfig.profile,
    provider: repoConfig.provider ?? orgConfig.provider,
    reviews: {
      auto_review: { ...orgConfig.reviews.auto_review, ...repoConfig.reviews.auto_review },
      path_filters: [...orgConfig.reviews.path_filters, ...repoConfig.reviews.path_filters],
      path_instructions: [
        ...orgConfig.reviews.path_instructions,
        ...repoConfig.reviews.path_instructions,
      ],
      max_files: repoConfig.reviews.max_files,
      max_diff_lines: repoConfig.reviews.max_diff_lines,
      ignore_authors: dedup([
        ...orgConfig.reviews.ignore_authors,
        ...repoConfig.reviews.ignore_authors,
      ]),
    },
    cost: { ...orgConfig.cost, ...repoConfig.cost },
    privacy: {
      redact_patterns: dedup([
        ...orgConfig.privacy.redact_patterns,
        ...repoConfig.privacy.redact_patterns,
      ]),
      deny_paths: dedup([...orgConfig.privacy.deny_paths, ...repoConfig.privacy.deny_paths]),
      allowed_url_prefixes: dedup([
        ...orgConfig.privacy.allowed_url_prefixes,
        ...repoConfig.privacy.allowed_url_prefixes,
      ]),
    },
    repo: { ...orgConfig.repo, ...repoConfig.repo },
    skills: [...orgConfig.skills, ...repoConfig.skills],
    incremental: { ...orgConfig.incremental, ...repoConfig.incremental },
  };
  // Run through Zod again so the merged object is structurally valid
  // (in particular, lists of `path_instructions` are revalidated).
  return ConfigSchema.parse(merged);
}

function dedup<T>(values: ReadonlyArray<T>): T[] {
  return [...new Set(values)];
}
