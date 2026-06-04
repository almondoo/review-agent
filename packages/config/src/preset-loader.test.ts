import { ConfigError } from '@review-agent/core';
import { describe, expect, it } from 'vitest';
import { loadConfigFromYaml } from './loader.js';
import {
  BUNDLED_PRESET_NAMES,
  deepMerge,
  PresetCycleError,
  PresetNotFoundError,
  resolveExtendsPresets,
} from './preset-loader.js';
import { ConfigSchema } from './schema.js';

// ---------------------------------------------------------------------------
// deepMerge — unit tests for override semantics
// ---------------------------------------------------------------------------

describe('deepMerge — override semantics', () => {
  it('scalar: source wins over target', () => {
    const result = deepMerge({ a: 1 }, { a: 2 });
    expect(result.a).toBe(2);
  });

  it('scalar: target value preserved when source omits the key', () => {
    const result = deepMerge({ a: 1, b: 'keep' }, { a: 2 });
    expect(result.b).toBe('keep');
  });

  it('object: deep-merges nested objects (child keys override matching parent keys)', () => {
    const target = { reviews: { max_files: 50, max_diff_lines: 3000 } };
    const source = { reviews: { max_files: 100 } };
    const result = deepMerge(target, source);
    expect(result.reviews).toEqual({ max_files: 100, max_diff_lines: 3000 });
  });

  it('object: unmatched parent keys are preserved after deep-merge', () => {
    const target = { a: { x: 1, y: 2 } };
    const source = { a: { x: 99 } };
    const result = deepMerge(target, source);
    expect(result.a).toEqual({ x: 99, y: 2 });
  });

  it('array: source REPLACES target array entirely (replace semantics)', () => {
    const target = { list: ['a', 'b', 'c'] };
    const source = { list: ['d'] };
    const result = deepMerge(target, source);
    expect(result.list).toEqual(['d']);
  });

  it('array: target array preserved when source omits it', () => {
    const target = { list: ['a', 'b'] };
    const source = { other: 1 };
    const result = deepMerge(target, source);
    expect(result.list).toEqual(['a', 'b']);
  });

  it('deeply nested objects are merged recursively', () => {
    const target = { a: { b: { c: 1, d: 2 } } };
    const source = { a: { b: { c: 99 } } };
    const result = deepMerge(target, source);
    expect(result.a).toEqual({ b: { c: 99, d: 2 } });
  });

  it('source null value replaces target value (null is a scalar)', () => {
    const target = { a: 'something' };
    const source = { a: null };
    const result = deepMerge(target, source);
    expect(result.a).toBeNull();
  });

  it('does not mutate target', () => {
    const target = { a: 1 };
    const source = { a: 2 };
    deepMerge(target, source);
    expect(target.a).toBe(1);
  });

  it('does not mutate source', () => {
    const target = { a: { x: 1 } };
    const source = { a: { x: 2 } };
    deepMerge(target, source);
    expect((source.a as { x: number }).x).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// BUNDLED_PRESET_NAMES
// ---------------------------------------------------------------------------

describe('BUNDLED_PRESET_NAMES', () => {
  it('contains exactly the three documented presets', () => {
    expect([...BUNDLED_PRESET_NAMES].sort()).toEqual(['recommended', 'security-focused', 'strict']);
  });
});

// ---------------------------------------------------------------------------
// resolveExtendsPresets — single preset
// ---------------------------------------------------------------------------

describe('resolveExtendsPresets — single preset', () => {
  it('resolves recommended preset and merges repo config on top', () => {
    const repo = { language: 'ja-JP' };
    const result = resolveExtendsPresets(['recommended'], repo);
    // repo wins
    expect(result.language).toBe('ja-JP');
    // preset default is present
    expect((result.reviews as Record<string, unknown>)?.max_files).toBe(50);
  });

  it('resolves strict preset (request_changes_on: major)', () => {
    const result = resolveExtendsPresets(['strict'], {});
    const reviews = result.reviews as Record<string, unknown>;
    expect(reviews?.request_changes_on).toBe('major');
  });

  it('resolves security-focused preset (maintainability disabled)', () => {
    const result = resolveExtendsPresets(['security-focused'], {});
    const ruleset = result.ruleset as Record<string, unknown>;
    expect((ruleset?.maintainability as Record<string, unknown>)?.enabled).toBe(false);
  });

  it('repo scalar overrides preset scalar', () => {
    const result = resolveExtendsPresets(['recommended'], { profile: 'assertive' });
    expect(result.profile).toBe('assertive');
  });

  it('repo object deep-merges with preset object (repo key wins, preset key preserved)', () => {
    const result = resolveExtendsPresets(['recommended'], {
      reviews: { max_files: 99 },
    });
    const reviews = result.reviews as Record<string, unknown>;
    // repo wins on max_files
    expect(reviews.max_files).toBe(99);
    // preset value preserved for max_diff_lines
    expect(reviews.max_diff_lines).toBe(3000);
  });

  it('repo array replaces preset array entirely', () => {
    const result = resolveExtendsPresets(['recommended'], {
      reviews: { path_filters: ['!vendor/**'] },
    });
    const reviews = result.reviews as Record<string, unknown>;
    expect(reviews.path_filters).toEqual(['!vendor/**']);
  });
});

// ---------------------------------------------------------------------------
// resolveExtendsPresets — multiple presets (array)
// ---------------------------------------------------------------------------

describe('resolveExtendsPresets — multiple presets', () => {
  it('merges left-to-right: later preset wins over earlier', () => {
    // recommended has request_changes_on: critical
    // strict has request_changes_on: major
    // strict applied after recommended → strict wins
    const result = resolveExtendsPresets(['recommended', 'strict'], {});
    const reviews = result.reviews as Record<string, unknown>;
    expect(reviews.request_changes_on).toBe('major');
  });

  it('repo config wins over all presets', () => {
    const result = resolveExtendsPresets(['recommended', 'strict'], {
      reviews: { request_changes_on: 'never' },
    });
    const reviews = result.reviews as Record<string, unknown>;
    expect(reviews.request_changes_on).toBe('never');
  });

  it('applies all three bundled presets without error', () => {
    expect(() =>
      resolveExtendsPresets(['recommended', 'strict', 'security-focused'], {}),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// PresetNotFoundError
// ---------------------------------------------------------------------------

describe('PresetNotFoundError — unknown preset name', () => {
  it('throws PresetNotFoundError for an unknown preset name', () => {
    expect(() => resolveExtendsPresets(['nonexistent-preset'], {})).toThrow(PresetNotFoundError);
  });

  it('error message includes the unknown preset name', () => {
    try {
      resolveExtendsPresets(['nonexistent-preset'], {});
    } catch (err) {
      expect(err instanceof PresetNotFoundError).toBe(true);
      if (err instanceof PresetNotFoundError) {
        expect(err.message).toContain('nonexistent-preset');
        expect(err.presetName).toBe('nonexistent-preset');
      }
    }
  });

  it('error message lists the valid bundled preset names', () => {
    try {
      resolveExtendsPresets(['bad-name'], {});
    } catch (err) {
      if (err instanceof PresetNotFoundError) {
        expect(err.message).toContain('recommended');
        expect(err.message).toContain('strict');
        expect(err.message).toContain('security-focused');
      }
    }
  });

  it('is a subclass of ConfigError', () => {
    try {
      resolveExtendsPresets(['bad-name'], {});
    } catch (err) {
      expect(err instanceof ConfigError).toBe(true);
    }
  });

  it('raises PresetNotFoundError with actionable message when org appears in array', () => {
    expect(() => resolveExtendsPresets(['org', 'recommended'], {})).toThrow(PresetNotFoundError);
  });
});

// ---------------------------------------------------------------------------
// PresetCycleError
// ---------------------------------------------------------------------------

describe('PresetCycleError', () => {
  it('is a subclass of ConfigError', () => {
    const err = new PresetCycleError(['a', 'b', 'a']);
    expect(err instanceof ConfigError).toBe(true);
  });

  it('message includes the cycle path', () => {
    const err = new PresetCycleError(['a', 'b', 'a']);
    expect(err.message).toContain('a → b → a');
    expect(err.cycle).toEqual(['a', 'b', 'a']);
  });

  it('throws PresetCycleError when the same preset appears twice in the list', () => {
    // Duplicate names in the extends array trigger cycle detection.
    expect(() => resolveExtendsPresets(['recommended', 'recommended'], {})).toThrow(
      PresetCycleError,
    );
  });
});

// ---------------------------------------------------------------------------
// Integration: loadConfigFromYaml with extends
// ---------------------------------------------------------------------------

describe('loadConfigFromYaml — extends: single preset name', () => {
  it('resolves extends: recommended and produces a valid Config', () => {
    const cfg = loadConfigFromYaml('extends: recommended\n');
    // Zod-validated Config is returned
    expect(cfg.reviews.max_files).toBe(50);
    expect(cfg.reviews.request_changes_on).toBe('critical');
    expect(cfg.ruleset.security?.enabled).toBe(true);
  });

  it('resolves extends: strict', () => {
    const cfg = loadConfigFromYaml('extends: strict\n');
    expect(cfg.reviews.request_changes_on).toBe('major');
    expect(cfg.reviews.max_files).toBe(100);
  });

  it('resolves extends: security-focused', () => {
    const cfg = loadConfigFromYaml('extends: security-focused\n');
    expect(cfg.ruleset.maintainability?.enabled).toBe(false);
    expect(cfg.ruleset.security?.min_severity).toBe('info');
  });

  it('repo config overrides preset scalar when extends is used', () => {
    const yaml = 'extends: recommended\nreviews:\n  max_files: 99\n';
    const cfg = loadConfigFromYaml(yaml);
    expect(cfg.reviews.max_files).toBe(99);
    // preset default preserved
    expect(cfg.reviews.max_diff_lines).toBe(3000);
  });

  it('repo config deep-merges with preset object', () => {
    const yaml = `extends: recommended
reviews:
  auto_review:
    drafts: true
`;
    const cfg = loadConfigFromYaml(yaml);
    expect(cfg.reviews.auto_review.drafts).toBe(true);
    // other auto_review keys preserved from preset
    expect(cfg.reviews.auto_review.enabled).toBe(true);
  });

  it('repo array replaces preset array (replace semantics, not append)', () => {
    const yaml = `extends: recommended
reviews:
  path_filters:
    - "!vendor/**"
`;
    const cfg = loadConfigFromYaml(yaml);
    // Only our single entry, not the preset list + our entry
    expect(cfg.reviews.path_filters).toEqual(['!vendor/**']);
  });

  it('throws PresetNotFoundError for unknown preset name', () => {
    expect(() => loadConfigFromYaml('extends: totally-unknown\n')).toThrow(PresetNotFoundError);
  });
});

describe('loadConfigFromYaml — extends: array of preset names', () => {
  it('resolves extends: [recommended, strict] and produces valid Config', () => {
    const yaml = 'extends:\n  - recommended\n  - strict\n';
    const cfg = loadConfigFromYaml(yaml);
    // strict applied after recommended → strict wins on request_changes_on
    expect(cfg.reviews.request_changes_on).toBe('major');
  });

  it('resolves extends: [recommended, security-focused]', () => {
    const yaml = 'extends:\n  - recommended\n  - security-focused\n';
    const cfg = loadConfigFromYaml(yaml);
    // security-focused disables maintainability
    expect(cfg.ruleset.maintainability?.enabled).toBe(false);
    // security-focused enables security with info min_severity
    expect(cfg.ruleset.security?.min_severity).toBe('info');
  });

  it('repo config wins over all presets in array extends', () => {
    const yaml = 'extends:\n  - recommended\n  - strict\nreviews:\n  request_changes_on: never\n';
    const cfg = loadConfigFromYaml(yaml);
    expect(cfg.reviews.request_changes_on).toBe('never');
  });

  it('throws PresetNotFoundError for unknown preset in array', () => {
    expect(() => loadConfigFromYaml('extends:\n  - recommended\n  - unknown-preset\n')).toThrow(
      PresetNotFoundError,
    );
  });

  it('throws PresetCycleError when same preset appears twice in array', () => {
    expect(() => loadConfigFromYaml('extends:\n  - recommended\n  - recommended\n')).toThrow(
      PresetCycleError,
    );
  });

  it('raises error when org appears in array extends', () => {
    expect(() => loadConfigFromYaml('extends:\n  - org\n  - recommended\n')).toThrow(ConfigError);
  });
});

describe('loadConfigFromYaml — extends: org (backward compat)', () => {
  it('passes extends: org through Zod without error (org handled by org-config)', () => {
    // The loader does NOT try to resolve 'org' as a preset name.
    // It passes the raw object with extends: 'org' to Zod for schema validation.
    // The org-merge is then done by loadConfigWithOrgFallback.
    const cfg = loadConfigFromYaml('extends: org\n');
    expect(cfg.extends).toBe('org');
  });

  it('passes extends: null through Zod (explicit opt-out)', () => {
    const cfg = loadConfigFromYaml('extends: null\n');
    expect(cfg.extends).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Bundled presets are valid ConfigSchema fragments
// ---------------------------------------------------------------------------

describe('bundled presets — schema validity', () => {
  it('recommended is a valid ConfigSchema fragment (Zod parse succeeds)', () => {
    const cfg = loadConfigFromYaml('extends: recommended\n');
    expect(() => ConfigSchema.parse(cfg)).not.toThrow();
  });

  it('strict is a valid ConfigSchema fragment (Zod parse succeeds)', () => {
    const cfg = loadConfigFromYaml('extends: strict\n');
    expect(() => ConfigSchema.parse(cfg)).not.toThrow();
  });

  it('security-focused is a valid ConfigSchema fragment (Zod parse succeeds)', () => {
    const cfg = loadConfigFromYaml('extends: security-focused\n');
    expect(() => ConfigSchema.parse(cfg)).not.toThrow();
  });
});
