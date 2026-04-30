import { ConfigError } from '@review-agent/core';
import { describe, expect, it } from 'vitest';
import { defaultConfig, loadConfigFromYaml, mergeWithEnv } from './loader.js';

describe('loadConfigFromYaml — defaults', () => {
  it('parses an empty YAML and applies defaults', () => {
    const config = loadConfigFromYaml('');
    expect(config.language).toBe('en-US');
    expect(config.profile).toBe('chill');
    expect(config.reviews.auto_review.drafts).toBe(false);
    expect(config.reviews.auto_review.enabled).toBe(true);
    expect(config.reviews.ignore_authors).toEqual([
      'dependabot[bot]',
      'renovate[bot]',
      'github-actions[bot]',
    ]);
    expect(config.cost.max_usd_per_pr).toBe(1.0);
    expect(config.incremental.enabled).toBe(true);
  });
});

describe('loadConfigFromYaml — explicit values', () => {
  it('honors explicit language', () => {
    const cfg = loadConfigFromYaml('language: ja-JP\n');
    expect(cfg.language).toBe('ja-JP');
  });

  it('rejects unsupported language', () => {
    expect(() => loadConfigFromYaml('language: xx-XX\n')).toThrow(ConfigError);
  });

  it('parses provider block', () => {
    const cfg = loadConfigFromYaml('provider:\n  type: anthropic\n  model: claude-sonnet-4-6\n');
    expect(cfg.provider?.type).toBe('anthropic');
    expect(cfg.provider?.anthropic_cache_control).toBe(true);
  });

  it('rejects unknown top-level keys (strict)', () => {
    expect(() => loadConfigFromYaml('mystery: 1\n')).toThrow(ConfigError);
  });

  it('rejects malformed YAML', () => {
    expect(() => loadConfigFromYaml('language: [unclosed\n')).toThrow(ConfigError);
  });

  it('respects user-provided ignore_authors override', () => {
    const cfg = loadConfigFromYaml('reviews:\n  ignore_authors:\n    - my-bot\n');
    expect(cfg.reviews.ignore_authors).toEqual(['my-bot']);
  });

  it('respects user-provided drafts: true override', () => {
    const cfg = loadConfigFromYaml('reviews:\n  auto_review:\n    drafts: true\n');
    expect(cfg.reviews.auto_review.drafts).toBe(true);
  });

  it('parses path_instructions array', () => {
    const cfg = loadConfigFromYaml(
      `reviews:\n  path_instructions:\n    - path: "**/*.go"\n      instructions: "check errors"\n`,
    );
    expect(cfg.reviews.path_instructions).toHaveLength(1);
    expect(cfg.reviews.path_instructions[0]?.path).toBe('**/*.go');
  });

  it('rejects negative cost cap', () => {
    expect(() => loadConfigFromYaml('cost:\n  max_usd_per_pr: -1\n')).toThrow(ConfigError);
  });
});

describe('defaultConfig', () => {
  it('round-trips through ConfigSchema.parse', () => {
    const cfg = defaultConfig();
    expect(cfg.language).toBe('en-US');
    expect(cfg.skills).toEqual([]);
  });
});

describe('mergeWithEnv', () => {
  const base = defaultConfig();

  it('overrides language', () => {
    const out = mergeWithEnv(base, { REVIEW_AGENT_LANGUAGE: 'ja-JP' });
    expect(out.language).toBe('ja-JP');
  });

  it('rejects unsupported language env', () => {
    expect(() => mergeWithEnv(base, { REVIEW_AGENT_LANGUAGE: 'xx-XX' })).toThrow(ConfigError);
  });

  it('overrides provider when both type and model are set', () => {
    const out = mergeWithEnv(base, {
      REVIEW_AGENT_PROVIDER: 'openai',
      REVIEW_AGENT_MODEL: 'gpt-4o',
    });
    expect(out.provider?.type).toBe('openai');
    expect(out.provider?.model).toBe('gpt-4o');
  });

  it('refuses provider override when only one of type/model is set', () => {
    expect(() => mergeWithEnv(base, { REVIEW_AGENT_PROVIDER: 'openai' })).toThrow(ConfigError);
    expect(() => mergeWithEnv(base, { REVIEW_AGENT_MODEL: 'gpt-4o' })).toThrow(ConfigError);
  });

  it('overrides max_usd_per_pr', () => {
    const out = mergeWithEnv(base, { REVIEW_AGENT_MAX_USD_PER_PR: '2.5' });
    expect(out.cost.max_usd_per_pr).toBe(2.5);
  });

  it('rejects non-positive cost cap env', () => {
    expect(() => mergeWithEnv(base, { REVIEW_AGENT_MAX_USD_PER_PR: '-1' })).toThrow(ConfigError);
    expect(() => mergeWithEnv(base, { REVIEW_AGENT_MAX_USD_PER_PR: 'abc' })).toThrow(ConfigError);
  });

  it('returns config unchanged when env has no matching keys', () => {
    expect(mergeWithEnv(base, {})).toEqual(base);
  });
});
