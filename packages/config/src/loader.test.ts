import { ConfigError } from '@review-agent/core';
import { describe, expect, it } from 'vitest';
import {
  defaultConfig,
  loadConfigFromYaml,
  mergeWithEnv,
  resolveEffectiveConfig,
} from './loader.js';

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

  // #157: trigger_labels / skip_labels schema validation
  it('parses trigger_labels and skip_labels in auto_review', () => {
    const cfg = loadConfigFromYaml(
      `reviews:
  auto_review:
    trigger_labels: ["needs-review", "ready"]
    skip_labels: ["wip", "no-review"]
`,
    );
    expect(cfg.reviews.auto_review.trigger_labels).toEqual(['needs-review', 'ready']);
    expect(cfg.reviews.auto_review.skip_labels).toEqual(['wip', 'no-review']);
  });

  it('defaults trigger_labels and skip_labels to empty arrays', () => {
    const cfg = loadConfigFromYaml('');
    expect(cfg.reviews.auto_review.trigger_labels).toEqual([]);
    expect(cfg.reviews.auto_review.skip_labels).toEqual([]);
  });

  it('rejects empty string entries in trigger_labels', () => {
    expect(() =>
      loadConfigFromYaml('reviews:\n  auto_review:\n    trigger_labels: ["needs-review", ""]\n'),
    ).toThrow(ConfigError);
  });

  it('rejects empty string entries in skip_labels', () => {
    expect(() => loadConfigFromYaml('reviews:\n  auto_review:\n    skip_labels: [""]\n')).toThrow(
      ConfigError,
    );
  });

  it('parses path_instructions array', () => {
    const cfg = loadConfigFromYaml(
      `reviews:\n  path_instructions:\n    - path: "**/*.go"\n      instructions: "check errors"\n`,
    );
    expect(cfg.reviews.path_instructions).toHaveLength(1);
    expect(cfg.reviews.path_instructions[0]?.path).toBe('**/*.go');
  });

  it('rejects a path_instructions entry whose `path` is not a valid glob', () => {
    // `src/utils/\*.ts` has an unbalanced escape inside the glob — the
    // runner's tool dispatcher and the config schema share the same
    // tiny glob compiler, so the typo should fail at config load
    // time rather than silently never match at runtime. The current
    // glob compiler is permissive on most strings, so we use a NUL
    // byte to trip the "must not contain a NUL byte" branch as a
    // robust signal that the validator is actually running.
    const NUL = String.fromCharCode(0);
    const yaml = `reviews:\n  path_instructions:\n    - path: "src/${NUL}.ts"\n      instructions: "ok"\n`;
    expect(() => loadConfigFromYaml(yaml)).toThrow(ConfigError);
  });

  it('rejects an empty `path` on path_instructions', () => {
    expect(() =>
      loadConfigFromYaml(
        'reviews:\n  path_instructions:\n    - path: ""\n      instructions: "ok"\n',
      ),
    ).toThrow(ConfigError);
  });

  it('rejects a privacy.deny_paths entry that is not a valid glob (M-1)', () => {
    // Mirrors the path_instructions[*].path validation: the runner
    // compiles each deny_paths entry with the same globToRegExp on
    // every review. A NUL-containing pattern would throw at runtime
    // and fail the whole review loudly; better to fail at YAML load
    // so the operator sees the misconfiguration before any review
    // runs. The empty-string branch is already covered by `.min(1)`.
    const NUL = String.fromCharCode(0);
    const yaml = `privacy:\n  deny_paths:\n    - "compliance/${NUL}.txt"\n`;
    expect(() => loadConfigFromYaml(yaml)).toThrow(ConfigError);
  });

  it('rejects an empty privacy.deny_paths entry', () => {
    expect(() => loadConfigFromYaml('privacy:\n  deny_paths:\n    - ""\n')).toThrow(ConfigError);
  });

  it('parses a privacy.redact_patterns entry that compiles as a regex (#87)', () => {
    const cfg = loadConfigFromYaml('privacy:\n  redact_patterns:\n    - "AKIA[0-9A-Z]{16}"\n');
    expect(cfg.privacy.redact_patterns).toEqual(['AKIA[0-9A-Z]{16}']);
  });

  it('rejects a privacy.redact_patterns entry that is not a valid regex (#87)', () => {
    // `[a-z` has an unbalanced bracket — `new RegExp` throws
    // SyntaxError, so we surface that at YAML load time instead of
    // letting the runner crash mid-scan when it lifts the pattern
    // into a gitleaks `[[rules]]` block.
    expect(() => loadConfigFromYaml('privacy:\n  redact_patterns:\n    - "[a-z"\n')).toThrow(
      ConfigError,
    );
  });

  it('rejects an empty privacy.redact_patterns entry (#87)', () => {
    expect(() => loadConfigFromYaml('privacy:\n  redact_patterns:\n    - ""\n')).toThrow(
      ConfigError,
    );
  });

  it('parses path_instructions[*].auto_fetch with explicit fields', () => {
    const cfg = loadConfigFromYaml(
      [
        'reviews:',
        '  path_instructions:',
        '    - path: "src/**/*.ts"',
        '      instructions: "strict types"',
        '      auto_fetch:',
        '        tests: true',
        '        types: false',
        '        siblings: true',
        '',
      ].join('\n'),
    );
    expect(cfg.reviews.path_instructions[0]?.auto_fetch).toEqual({
      tests: true,
      types: false,
      siblings: true,
    });
  });

  it('omits auto_fetch when not supplied (no default object is injected)', () => {
    const cfg = loadConfigFromYaml(
      'reviews:\n  path_instructions:\n    - path: "**/*.go"\n      instructions: "x"\n',
    );
    // auto_fetch is intentionally optional (`undefined`) rather than
    // a default object — operators who don't set it get the runner's
    // built-in defaults, not a Zod-defaulted shape that locks in a
    // schema-versioned representation.
    expect(cfg.reviews.path_instructions[0]?.auto_fetch).toBeUndefined();
  });

  it('rejects negative cost cap', () => {
    expect(() => loadConfigFromYaml('cost:\n  max_usd_per_pr: -1\n')).toThrow(ConfigError);
  });

  it('defaults coordination.other_bots to ignore with no operator overrides', () => {
    const cfg = loadConfigFromYaml('');
    expect(cfg.coordination.other_bots).toBe('ignore');
    expect(cfg.coordination.other_bots_logins).toEqual([]);
  });

  it("defaults reviews.min_confidence to 'low' (post everything)", () => {
    const cfg = loadConfigFromYaml('');
    expect(cfg.reviews.min_confidence).toBe('low');
  });

  it("parses reviews.min_confidence: 'medium'", () => {
    const cfg = loadConfigFromYaml('reviews:\n  min_confidence: medium\n');
    expect(cfg.reviews.min_confidence).toBe('medium');
  });

  it("parses reviews.min_confidence: 'high'", () => {
    const cfg = loadConfigFromYaml('reviews:\n  min_confidence: high\n');
    expect(cfg.reviews.min_confidence).toBe('high');
  });

  it('rejects an unknown reviews.min_confidence value', () => {
    expect(() => loadConfigFromYaml('reviews:\n  min_confidence: certain\n')).toThrow(ConfigError);
  });

  it('parses coordination.other_bots: defer_if_present + custom logins', () => {
    const cfg = loadConfigFromYaml(
      'coordination:\n  other_bots: defer_if_present\n  other_bots_logins:\n    - my-internal-reviewer[bot]\n',
    );
    expect(cfg.coordination.other_bots).toBe('defer_if_present');
    expect(cfg.coordination.other_bots_logins).toEqual(['my-internal-reviewer[bot]']);
  });

  it('rejects unknown coordination.other_bots mode', () => {
    expect(() => loadConfigFromYaml('coordination:\n  other_bots: ask_first\n')).toThrow(
      ConfigError,
    );
  });

  it("defaults server.workspace_strategy to 'none' (v0.2 behavior)", () => {
    const cfg = loadConfigFromYaml('');
    expect(cfg.server.workspace_strategy).toBe('none');
  });

  it("parses server.workspace_strategy: 'contents-api'", () => {
    const cfg = loadConfigFromYaml('server:\n  workspace_strategy: contents-api\n');
    expect(cfg.server.workspace_strategy).toBe('contents-api');
  });

  it("parses server.workspace_strategy: 'sparse-clone'", () => {
    const cfg = loadConfigFromYaml('server:\n  workspace_strategy: sparse-clone\n');
    expect(cfg.server.workspace_strategy).toBe('sparse-clone');
  });

  it('rejects an unknown server.workspace_strategy value', () => {
    expect(() => loadConfigFromYaml('server:\n  workspace_strategy: docker\n')).toThrow(
      ConfigError,
    );
  });

  it("defaults codecommit.approvalState to 'off' (v0.2 back-compat)", () => {
    const cfg = loadConfigFromYaml('');
    expect(cfg.codecommit.approvalState).toBe('off');
  });

  it("parses codecommit.approvalState: 'managed'", () => {
    const cfg = loadConfigFromYaml('codecommit:\n  approvalState: managed\n');
    expect(cfg.codecommit.approvalState).toBe('managed');
  });

  it('rejects an unknown codecommit.approvalState value', () => {
    expect(() => loadConfigFromYaml('codecommit:\n  approvalState: blocking\n')).toThrow(
      ConfigError,
    );
  });
});

describe('defaultConfig', () => {
  it('round-trips through ConfigSchema.parse', () => {
    const cfg = defaultConfig();
    expect(cfg.language).toBe('en-US');
    expect(cfg.skills).toEqual([]);
  });
});

describe('loadConfigFromYaml — ruleset block (#148)', () => {
  it('defaults ruleset to an empty record (no filtering)', () => {
    const cfg = loadConfigFromYaml('');
    expect(cfg.ruleset).toEqual({});
  });

  it('parses a single enabled category with default min_severity', () => {
    const cfg = loadConfigFromYaml('ruleset:\n  security:\n    enabled: true\n');
    expect(cfg.ruleset.security).toEqual({ enabled: true, min_severity: 'info' });
  });

  it('parses enabled: false to suppress a category', () => {
    const cfg = loadConfigFromYaml('ruleset:\n  style:\n    enabled: false\n');
    expect(cfg.ruleset.style).toEqual({ enabled: false, min_severity: 'info' });
  });

  it('parses min_severity: major to filter low-severity findings', () => {
    const cfg = loadConfigFromYaml('ruleset:\n  performance:\n    min_severity: major\n');
    expect(cfg.ruleset.performance).toEqual({ enabled: true, min_severity: 'major' });
  });

  it('parses multiple categories in one block', () => {
    const yaml = [
      'ruleset:',
      '  security:',
      '    enabled: true',
      '    min_severity: major',
      '  style:',
      '    enabled: false',
      '  bug:',
      '    min_severity: critical',
    ].join('\n');
    const cfg = loadConfigFromYaml(yaml);
    expect(cfg.ruleset.security).toEqual({ enabled: true, min_severity: 'major' });
    expect(cfg.ruleset.style).toEqual({ enabled: false, min_severity: 'info' });
    expect(cfg.ruleset.bug).toEqual({ enabled: true, min_severity: 'critical' });
  });

  it('rejects an unknown category key in the ruleset block', () => {
    // 'correctness' is not a CATEGORIES value — Zod should reject it.
    expect(() => loadConfigFromYaml('ruleset:\n  correctness:\n    enabled: true\n')).toThrow(
      ConfigError,
    );
  });

  it('rejects an unknown min_severity value in ruleset', () => {
    // 'low' and 'medium' are from the issue-body examples but not in SEVERITIES.
    expect(() => loadConfigFromYaml('ruleset:\n  security:\n    min_severity: low\n')).toThrow(
      ConfigError,
    );
  });

  it('rejects an unknown min_severity value: high (not in SEVERITIES)', () => {
    // SEVERITIES is ['critical','major','minor','info'] — 'high' is not valid.
    expect(() => loadConfigFromYaml('ruleset:\n  security:\n    min_severity: high\n')).toThrow(
      ConfigError,
    );
  });

  it('rejects an extra key inside a category entry (strict schema)', () => {
    expect(() =>
      loadConfigFromYaml('ruleset:\n  security:\n    enabled: true\n    extra: nope\n'),
    ).toThrow(ConfigError);
  });

  it('all known CATEGORIES are accepted as valid ruleset keys', () => {
    // Regression guard: every CATEGORIES entry must parse without error.
    const yaml = [
      'ruleset:',
      '  bug:',
      '    enabled: true',
      '  security:',
      '    enabled: true',
      '  performance:',
      '    enabled: true',
      '  maintainability:',
      '    enabled: true',
      '  style:',
      '    enabled: true',
      '  docs:',
      '    enabled: true',
      '  test:',
      '    enabled: true',
    ].join('\n');
    const cfg = loadConfigFromYaml(yaml);
    expect(Object.keys(cfg.ruleset)).toHaveLength(7);
  });
});

describe('resolveEffectiveConfig', () => {
  describe('precedence: repo > org > defaults', () => {
    it('primarySource is "repo-yaml" when repo YAML is provided', () => {
      const { log } = resolveEffectiveConfig({ repoYaml: 'language: ja-JP\n' });
      expect(log.primarySource).toBe('repo-yaml');
    });

    it('primarySource is "org-yaml" when only org YAML is provided', () => {
      const { log } = resolveEffectiveConfig({ repoYaml: null, orgYaml: 'language: ja-JP\n' });
      expect(log.primarySource).toBe('org-yaml');
    });

    it('primarySource is "default" when neither YAML is provided', () => {
      const { log } = resolveEffectiveConfig({ repoYaml: null });
      expect(log.primarySource).toBe('default');
    });

    it('repo YAML wins over org YAML (repo takes precedence)', () => {
      // When repoYaml is present, it always has higher precedence.
      // Even if orgYaml is also supplied, the repo is the primary source.
      const { config, log } = resolveEffectiveConfig({
        repoYaml: 'language: ja-JP\nprofile: assertive\n',
        orgYaml: 'language: zh-CN\n',
      });
      expect(config.language).toBe('ja-JP');
      expect(log.primarySource).toBe('repo-yaml');
      expect(log.orgYamlLoaded).toBe(true);
    });

    it('org YAML is used when repo YAML is absent', () => {
      const { config, log } = resolveEffectiveConfig({
        repoYaml: null,
        orgYaml: 'language: zh-CN\n',
      });
      expect(config.language).toBe('zh-CN');
      expect(log.primarySource).toBe('org-yaml');
      expect(log.orgYamlLoaded).toBe(true);
    });

    it('defaults apply when both YAML sources are absent', () => {
      const { config, log } = resolveEffectiveConfig({ repoYaml: null });
      expect(config.language).toBe('en-US');
      expect(config.profile).toBe('chill');
      expect(log.primarySource).toBe('default');
      expect(log.orgYamlLoaded).toBe(false);
    });
  });

  describe('ConfigResolutionLog — source recording', () => {
    it('records orgYamlLoaded=false when orgYaml is not supplied', () => {
      const { log } = resolveEffectiveConfig({ repoYaml: 'language: ja-JP\n' });
      expect(log.orgYamlLoaded).toBe(false);
    });

    it('records orgYamlLoaded=true when orgYaml is supplied alongside repoYaml', () => {
      const { log } = resolveEffectiveConfig({
        repoYaml: 'language: ja-JP\n',
        orgYaml: 'language: zh-CN\n',
      });
      expect(log.orgYamlLoaded).toBe(true);
    });

    it('records envApplied=false when env is empty', () => {
      const { log } = resolveEffectiveConfig({ repoYaml: 'language: ja-JP\n', env: {} });
      expect(log.envApplied).toBe(false);
    });

    it('records envApplied=false when env overrides are absent (no env arg)', () => {
      const { log } = resolveEffectiveConfig({ repoYaml: 'language: ja-JP\n' });
      expect(log.envApplied).toBe(false);
    });

    it('records envApplied=true when at least one REVIEW_AGENT_* env var is set', () => {
      const { log } = resolveEffectiveConfig({
        repoYaml: 'language: ja-JP\n',
        env: { REVIEW_AGENT_LANGUAGE: 'en-US' },
      });
      expect(log.envApplied).toBe(true);
    });

    it('applies env overrides to the final config (current §10.2 behaviour, see #156)', () => {
      // NOTE(#156): env currently overrides config. Once #156 corrects
      // §10.2 precedence (config > env), this test may be updated.
      const { config } = resolveEffectiveConfig({
        repoYaml: 'language: ja-JP\n',
        env: { REVIEW_AGENT_LANGUAGE: 'en-US' },
      });
      expect(config.language).toBe('en-US');
    });
  });

  describe('ConfigResolutionLog — sections map', () => {
    it('marks language as repo-yaml when explicitly set in repo YAML', () => {
      const { log } = resolveEffectiveConfig({ repoYaml: 'language: ja-JP\n' });
      expect(log.sections.language).toBe('repo-yaml');
    });

    it('marks language as default when only the Zod default is active', () => {
      const { log } = resolveEffectiveConfig({ repoYaml: '' });
      expect(log.sections.language).toBe('default');
    });

    it('marks provider as repo-yaml when set in repo YAML', () => {
      const { log } = resolveEffectiveConfig({
        repoYaml: 'provider:\n  type: anthropic\n  model: claude-sonnet-4-6\n',
      });
      expect(log.sections.provider).toBe('repo-yaml');
    });

    it('marks cost as default when cost section not in YAML', () => {
      const { log } = resolveEffectiveConfig({ repoYaml: 'language: ja-JP\n' });
      expect(log.sections.cost).toBe('default');
    });

    it('marks cost as repo-yaml when cost section is explicitly set', () => {
      const { log } = resolveEffectiveConfig({
        repoYaml: 'cost:\n  max_usd_per_pr: 2.0\n',
      });
      expect(log.sections.cost).toBe('repo-yaml');
    });

    it('marks org-yaml sections when orgYaml is the sole source', () => {
      const { log } = resolveEffectiveConfig({
        repoYaml: null,
        orgYaml: 'language: zh-CN\n',
      });
      expect(log.sections.language).toBe('org-yaml');
    });
  });

  describe('error propagation', () => {
    it('propagates ConfigError for invalid repo YAML', () => {
      expect(() => resolveEffectiveConfig({ repoYaml: 'language: xx-XX\n' })).toThrow(ConfigError);
    });

    it('propagates ConfigError for invalid org YAML', () => {
      expect(() =>
        resolveEffectiveConfig({ repoYaml: null, orgYaml: 'language: xx-XX\n' }),
      ).toThrow(ConfigError);
    });

    it('propagates ConfigError for invalid env override', () => {
      expect(() =>
        resolveEffectiveConfig({
          repoYaml: null,
          env: { REVIEW_AGENT_LANGUAGE: 'xx-XX' },
        }),
      ).toThrow(ConfigError);
    });
  });
});

describe('loadConfigFromYaml — reviews.max_steps (#156)', () => {
  it('defaults reviews.max_steps to 20 (matches MAX_TOOL_CALLS)', () => {
    const cfg = loadConfigFromYaml('');
    expect(cfg.reviews.max_steps).toBe(20);
  });

  it('parses reviews.max_steps: 30', () => {
    const cfg = loadConfigFromYaml('reviews:\n  max_steps: 30\n');
    expect(cfg.reviews.max_steps).toBe(30);
  });

  it('parses reviews.max_steps: 1 (lower bound)', () => {
    const cfg = loadConfigFromYaml('reviews:\n  max_steps: 1\n');
    expect(cfg.reviews.max_steps).toBe(1);
  });

  it('parses reviews.max_steps: 50 (upper bound)', () => {
    const cfg = loadConfigFromYaml('reviews:\n  max_steps: 50\n');
    expect(cfg.reviews.max_steps).toBe(50);
  });

  it('rejects reviews.max_steps: 0 (below min)', () => {
    expect(() => loadConfigFromYaml('reviews:\n  max_steps: 0\n')).toThrow(ConfigError);
  });

  it('rejects reviews.max_steps: 51 (above max)', () => {
    expect(() => loadConfigFromYaml('reviews:\n  max_steps: 51\n')).toThrow(ConfigError);
  });

  it('rejects reviews.max_steps: 1.5 (non-integer)', () => {
    expect(() => loadConfigFromYaml('reviews:\n  max_steps: 1.5\n')).toThrow(ConfigError);
  });

  it('rejects reviews.max_steps: -1 (negative)', () => {
    expect(() => loadConfigFromYaml('reviews:\n  max_steps: -1\n')).toThrow(ConfigError);
  });
});

describe('loadConfigFromYaml — reviews.max_conversation_turns (#149)', () => {
  it('defaults reviews.max_conversation_turns to 5', () => {
    expect(loadConfigFromYaml('').reviews.max_conversation_turns).toBe(5);
  });

  it('parses an explicit reviews.max_conversation_turns: 10', () => {
    expect(
      loadConfigFromYaml('reviews:\n  max_conversation_turns: 10\n').reviews.max_conversation_turns,
    ).toBe(10);
  });

  it('rejects reviews.max_conversation_turns: 0 (below min)', () => {
    expect(() => loadConfigFromYaml('reviews:\n  max_conversation_turns: 0\n')).toThrow(
      ConfigError,
    );
  });

  it('rejects reviews.max_conversation_turns: 51 (above max)', () => {
    expect(() => loadConfigFromYaml('reviews:\n  max_conversation_turns: 51\n')).toThrow(
      ConfigError,
    );
  });
});

describe('loadConfigFromYaml — feedback block (#155)', () => {
  it('defaults feedback.suppress_after to 3', () => {
    expect(loadConfigFromYaml('').feedback.suppress_after).toBe(3);
  });

  it('parses an explicit feedback.suppress_after: 5', () => {
    expect(loadConfigFromYaml('feedback:\n  suppress_after: 5\n').feedback.suppress_after).toBe(5);
  });

  it('rejects feedback.suppress_after: 0 (below min)', () => {
    expect(() => loadConfigFromYaml('feedback:\n  suppress_after: 0\n')).toThrow(ConfigError);
  });

  it('rejects an unknown key inside feedback (strict)', () => {
    expect(() => loadConfigFromYaml('feedback:\n  bogus: 1\n')).toThrow(ConfigError);
  });
});

describe('resolveEffectiveConfig — max_steps precedence (config > env > default, #156)', () => {
  it('uses YAML max_steps when explicitly set — ignores env var (config wins over env)', () => {
    const { config } = resolveEffectiveConfig({
      repoYaml: 'reviews:\n  max_steps: 30\n',
      env: { REVIEW_AGENT_MAX_STEPS: '10' },
    });
    // Config (30) must win over env (10).
    expect(config.reviews.max_steps).toBe(30);
  });

  it('uses env var when YAML does not set max_steps (env overrides default)', () => {
    const { config } = resolveEffectiveConfig({
      repoYaml: 'language: ja-JP\n',
      env: { REVIEW_AGENT_MAX_STEPS: '15' },
    });
    // YAML omits max_steps → env (15) wins over default (20).
    expect(config.reviews.max_steps).toBe(15);
  });

  it('falls back to default 20 when neither YAML nor env sets max_steps', () => {
    const { config } = resolveEffectiveConfig({ repoYaml: null });
    expect(config.reviews.max_steps).toBe(20);
  });

  it('uses env var when repoYaml is null (no YAML at all)', () => {
    const { config } = resolveEffectiveConfig({
      repoYaml: null,
      env: { REVIEW_AGENT_MAX_STEPS: '5' },
    });
    expect(config.reviews.max_steps).toBe(5);
  });

  it('uses YAML max_steps: 20 explicitly — still ignores env (explicit YAML beats env even at default value)', () => {
    // This case proves we check raw YAML key presence, not value-equality to 20.
    const { config } = resolveEffectiveConfig({
      repoYaml: 'reviews:\n  max_steps: 20\n',
      env: { REVIEW_AGENT_MAX_STEPS: '5' },
    });
    expect(config.reviews.max_steps).toBe(20);
  });

  it('rejects out-of-range REVIEW_AGENT_MAX_STEPS (below 1)', () => {
    expect(() =>
      resolveEffectiveConfig({
        repoYaml: null,
        env: { REVIEW_AGENT_MAX_STEPS: '0' },
      }),
    ).toThrow(ConfigError);
  });

  it('rejects out-of-range REVIEW_AGENT_MAX_STEPS (above 50)', () => {
    expect(() =>
      resolveEffectiveConfig({
        repoYaml: null,
        env: { REVIEW_AGENT_MAX_STEPS: '100' },
      }),
    ).toThrow(ConfigError);
  });

  it('rejects non-integer REVIEW_AGENT_MAX_STEPS', () => {
    expect(() =>
      resolveEffectiveConfig({
        repoYaml: null,
        env: { REVIEW_AGENT_MAX_STEPS: 'abc' },
      }),
    ).toThrow(ConfigError);
  });

  it('records envApplied=true when REVIEW_AGENT_MAX_STEPS is set and YAML omits max_steps', () => {
    const { log } = resolveEffectiveConfig({
      repoYaml: null,
      env: { REVIEW_AGENT_MAX_STEPS: '10' },
    });
    expect(log.envApplied).toBe(true);
  });

  it('records envApplied=true when REVIEW_AGENT_MAX_STEPS is set and YAML overrides it (env still counted)', () => {
    // envApplied tracks that env vars were present, not that they were used.
    const { log } = resolveEffectiveConfig({
      repoYaml: 'reviews:\n  max_steps: 30\n',
      env: { REVIEW_AGENT_MAX_STEPS: '10' },
    });
    expect(log.envApplied).toBe(true);
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
