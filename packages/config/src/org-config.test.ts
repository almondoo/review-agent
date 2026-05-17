import { describe, expect, it, vi } from 'vitest';
import { ConfigSchema, defaultConfig, loadConfigFromYaml } from './index.js';
import {
  createOrgConfigCache,
  loadConfigWithOrgFallback,
  mergeOrgIntoRepo,
  type OrgConfigFetch,
} from './org-config.js';

const orgYaml = `
language: ja-JP
profile: assertive
reviews:
  ignore_authors: ["dependabot[bot]", "fly-bot"]
  path_filters: ["src/**", "lib/**"]
skills: ["org-skill-a", "org-skill-b"]
cost:
  max_usd_per_pr: 0.50
`;

const repoYaml = `
extends: org
profile: chill
reviews:
  ignore_authors: ["repo-bot"]
  path_filters: ["app/**"]
skills: ["repo-skill"]
cost:
  max_usd_per_pr: 1.50
`;

describe('createOrgConfigCache', () => {
  it('caches the fetch result for the configured TTL', async () => {
    let now = 0;
    const fetch: OrgConfigFetch = vi.fn(async () => 'language: ja-JP\n');
    const cache = createOrgConfigCache(fetch, { ttlMs: 10, now: () => now });
    expect(await cache.get('o')).toBe('language: ja-JP\n');
    expect(await cache.get('o')).toBe('language: ja-JP\n');
    expect(fetch).toHaveBeenCalledTimes(1);
    now = 100;
    expect(await cache.get('o')).toBe('language: ja-JP\n');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('caches null (missing-org-config) results so we do not hammer the API', async () => {
    const fetch: OrgConfigFetch = vi.fn(async () => null);
    const cache = createOrgConfigCache(fetch, { ttlMs: 60_000 });
    expect(await cache.get('o')).toBeNull();
    expect(await cache.get('o')).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('invalidate() clears one owner; invalidate() with no arg clears all', async () => {
    let returns = 0;
    const fetch: OrgConfigFetch = vi.fn(async () => `# ${returns++}\nlanguage: en-US\n`);
    const cache = createOrgConfigCache(fetch, { ttlMs: 60_000 });
    await cache.get('a');
    await cache.get('b');
    cache.invalidate('a');
    await cache.get('a');
    await cache.get('b');
    expect(fetch).toHaveBeenCalledTimes(3);
    cache.invalidate();
    await cache.get('a');
    await cache.get('b');
    expect(fetch).toHaveBeenCalledTimes(5);
  });
});

describe('loadConfigWithOrgFallback', () => {
  function fakeCache(text: string | null) {
    return {
      get: vi.fn(async () => text),
      invalidate: vi.fn(),
    };
  }

  it('uses repo config alone when extends is not set', async () => {
    const result = await loadConfigWithOrgFallback({
      owner: 'acme',
      repoYaml: 'language: ja-JP\n',
      orgConfigCache: fakeCache(orgYaml),
    });
    expect(result.source).toBe('repo');
    expect(result.config.language).toBe('ja-JP');
    expect(result.config.skills).toEqual([]);
  });

  it('merges org under repo when repo says extends: org', async () => {
    const result = await loadConfigWithOrgFallback({
      owner: 'acme',
      repoYaml,
      orgConfigCache: fakeCache(orgYaml),
    });
    expect(result.source).toBe('repo+org');
    // scalar: repo wins
    expect(result.config.profile).toBe('chill');
    // list: concat (org first, then repo)
    expect(result.config.skills).toEqual(['org-skill-a', 'org-skill-b', 'repo-skill']);
    expect(result.config.reviews.path_filters).toEqual(['src/**', 'lib/**', 'app/**']);
    // ignore_authors deduped (repo-bot + dependabot[bot] from org + fly-bot)
    expect(new Set(result.config.reviews.ignore_authors)).toEqual(
      new Set(['dependabot[bot]', 'fly-bot', 'repo-bot']),
    );
    // cost.max_usd_per_pr: repo wins
    expect(result.config.cost.max_usd_per_pr).toBe(1.5);
    // language: repo absent → falls back to default 'en-US' (extends doesn't make org win)
    expect(result.config.language).toBe('en-US');
  });

  it('returns org config alone when repo file is absent', async () => {
    const result = await loadConfigWithOrgFallback({
      owner: 'acme',
      repoYaml: null,
      orgConfigCache: fakeCache(orgYaml),
    });
    expect(result.source).toBe('org');
    expect(result.config.language).toBe('ja-JP');
    expect(result.config.skills).toEqual(['org-skill-a', 'org-skill-b']);
  });

  it('returns defaults when both files are absent', async () => {
    const result = await loadConfigWithOrgFallback({
      owner: 'acme',
      repoYaml: null,
      orgConfigCache: fakeCache(null),
    });
    expect(result.source).toBe('defaults');
    expect(result.config).toEqual(defaultConfig());
  });

  it('throws when extends: org is set but org config is missing', async () => {
    await expect(() =>
      loadConfigWithOrgFallback({
        owner: 'acme',
        repoYaml,
        orgConfigCache: fakeCache(null),
      }),
    ).rejects.toThrow(/extends: org/);
  });

  it('does not call the cache when repo config has no extends', async () => {
    const cache = fakeCache(orgYaml);
    await loadConfigWithOrgFallback({
      owner: 'acme',
      repoYaml: 'language: en-US\n',
      orgConfigCache: cache,
    });
    expect(cache.get).not.toHaveBeenCalled();
  });
});

describe('mergeOrgIntoRepo', () => {
  it('clears extends on the merged result so re-merging is idempotent', () => {
    const merged = mergeOrgIntoRepo(loadConfigFromYaml(orgYaml), loadConfigFromYaml(repoYaml));
    // After merge, extends is null — feeding the result back into the
    // resolver does not trigger another merge cycle.
    expect(merged.extends).toBeNull();
    // sanity-check via Zod
    expect(() => ConfigSchema.parse(merged)).not.toThrow();
  });

  it('repo provider wins over org provider', () => {
    const org = loadConfigFromYaml(`provider:
  type: anthropic
  model: claude-sonnet-4-6
`);
    const repo = loadConfigFromYaml(`extends: org
provider:
  type: openai
  model: gpt-5
`);
    const merged = mergeOrgIntoRepo(org, repo);
    expect(merged.provider?.type).toBe('openai');
    expect(merged.provider?.model).toBe('gpt-5');
  });

  it('org provider passes through when repo omits provider', () => {
    const org = loadConfigFromYaml(`provider:
  type: anthropic
  model: claude-sonnet-4-6
`);
    const repo = loadConfigFromYaml('extends: org\n');
    const merged = mergeOrgIntoRepo(org, repo);
    expect(merged.provider?.type).toBe('anthropic');
  });

  it('dedups privacy.redact_patterns across org and repo (#87)', () => {
    // The org and repo both declare the same AWS access-key pattern;
    // without dedup the runner would lift two identical custom rules
    // into gitleaks TOML and gitleaks rejects duplicate rule ids.
    // This mirrors the deny_paths / allowed_url_prefixes treatment.
    const org = loadConfigFromYaml(
      `privacy:
  redact_patterns:
    - "AKIA[0-9A-Z]{16}"
    - "ghp_[A-Za-z0-9]{36}"
`,
    );
    const repo = loadConfigFromYaml(
      `extends: org
privacy:
  redact_patterns:
    - "AKIA[0-9A-Z]{16}"
    - "xoxb-[A-Za-z0-9-]+"
`,
    );
    const merged = mergeOrgIntoRepo(org, repo);
    expect(merged.privacy.redact_patterns).toEqual([
      'AKIA[0-9A-Z]{16}',
      'ghp_[A-Za-z0-9]{36}',
      'xoxb-[A-Za-z0-9-]+',
    ]);
  });
});
