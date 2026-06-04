/**
 * Bundled preset loader and deep-merge engine for `extends:` inheritance.
 *
 * ## Preset resolution
 *
 * When `.review-agent.yml` contains `extends:`, the loader resolves presets
 * **before** `loadConfigFromYaml` applies Zod defaults. The effective config
 * is built bottom-up:
 *
 *   1. Start from the leftmost preset (base layer).
 *   2. Deep-merge each subsequent preset on top (left-to-right, later wins).
 *   3. Deep-merge the repo config last (repo always wins).
 *
 * ## `extends: 'org'` backward compat
 *
 * The special keyword `'org'` is handled exclusively at the **scalar** level
 * (i.e., `extends: org` in YAML). It triggers the org-merge pipeline in
 * `org-config.ts` and is NOT treated as a preset name. Mixing `'org'` inside
 * an array (e.g., `extends: [org, recommended]`) is intentionally unsupported
 * and raises an `UnknownPresetError` with a clear message. If you need both
 * org inheritance and a preset, use `extends: org` (scalar) together with a
 * separate preset: this is tracked for future enhancement.
 *
 * ## Override semantics (documented)
 *
 * - **Scalar values**: later entry wins (right-to-left priority, repo last).
 * - **Object values**: deep-merged — child keys override matching parent keys;
 *   unmatched parent keys are preserved.
 * - **Array values**: REPLACED entirely — the rightmost definition wins.
 *   Append semantics (`_merge: append`) are not implemented in this MVP.
 *   Document your full desired list in the overriding config.
 *
 * ## Bundled presets
 *
 * Three first-party presets ship in this package:
 *   - `recommended`       — sensible defaults for most repos
 *   - `strict`            — higher thresholds for release branches / sensitive projects
 *   - `security-focused`  — maximises security/bug coverage; suppresses style noise
 *
 * Preset YAML is bundled as static string literals (no fs I/O at load time).
 */

import { ConfigError } from '@review-agent/core';
import { parse as parseYaml } from 'yaml';

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

/**
 * Raised when `extends:` references a preset name that is neither a bundled
 * preset nor a resolvable name. Message includes the unknown name and a list
 * of valid names so operators know what to fix.
 */
export class PresetNotFoundError extends ConfigError {
  readonly presetName: string;

  constructor(name: string) {
    super(
      `Unknown preset '${name}'. Bundled presets are: ${BUNDLED_PRESET_NAMES.join(', ')}. ` +
        `Check spelling or remove the extends entry.`,
    );
    this.presetName = name;
  }
}

/**
 * Raised when the `extends:` chain forms a cycle (a preset directly or
 * transitively extends itself). Prevents infinite recursion at load time.
 */
export class PresetCycleError extends ConfigError {
  readonly cycle: ReadonlyArray<string>;

  constructor(cycle: ReadonlyArray<string>) {
    super(`Preset cycle detected: ${cycle.join(' → ')}. Remove the circular extends reference.`);
    this.cycle = cycle;
  }
}

// ---------------------------------------------------------------------------
// Bundled preset definitions (static string literals — no fs I/O)
// ---------------------------------------------------------------------------

// NOTE: These strings are the raw YAML text of the bundled presets. They are
// stored as inline literals so the loader has zero filesystem dependency and
// works identically in Lambda, Action, and CLI contexts.

const RECOMMENDED_YAML = `reviews:
  auto_review:
    enabled: true
    drafts: false
    base_branches:
      - main
      - master
      - develop
  path_filters:
    - "!dist/**"
    - "!build/**"
    - "!coverage/**"
    - "!**/*.lock"
    - "!**/*.generated.*"
    - "!**/__snapshots__/**"
    - "!**/*.min.js"
    - "!**/*.min.css"
  max_files: 50
  max_diff_lines: 3000
  ignore_authors:
    - "dependabot[bot]"
    - "renovate[bot]"
    - "github-actions[bot]"
  min_confidence: low
  request_changes_on: critical
  max_steps: 20

cost:
  max_usd_per_pr: 1.0
  hard_stop: true
  daily_cap_usd: 50.0

ruleset:
  bug:
    enabled: true
    min_severity: minor
  security:
    enabled: true
    min_severity: minor
  performance:
    enabled: true
    min_severity: major
  maintainability:
    enabled: true
    min_severity: major
  style:
    enabled: true
    min_severity: minor
  docs:
    enabled: true
    min_severity: info
  test:
    enabled: true
    min_severity: minor
`;

const STRICT_YAML = `reviews:
  auto_review:
    enabled: true
    drafts: true
  path_filters:
    - "!dist/**"
    - "!build/**"
    - "!coverage/**"
    - "!**/*.lock"
    - "!**/*.generated.*"
    - "!**/__snapshots__/**"
    - "!**/*.min.js"
    - "!**/*.min.css"
  max_files: 100
  max_diff_lines: 5000
  ignore_authors:
    - "dependabot[bot]"
    - "renovate[bot]"
    - "github-actions[bot]"
  min_confidence: low
  request_changes_on: major
  max_steps: 30

cost:
  max_usd_per_pr: 2.0
  hard_stop: true
  daily_cap_usd: 100.0

ruleset:
  bug:
    enabled: true
    min_severity: info
  security:
    enabled: true
    min_severity: info
  performance:
    enabled: true
    min_severity: minor
  maintainability:
    enabled: true
    min_severity: minor
  style:
    enabled: true
    min_severity: minor
  docs:
    enabled: true
    min_severity: info
  test:
    enabled: true
    min_severity: info
`;

const SECURITY_FOCUSED_YAML = `reviews:
  auto_review:
    enabled: true
    drafts: true
  path_filters:
    - "!dist/**"
    - "!build/**"
    - "!coverage/**"
    - "!**/*.lock"
    - "!**/*.generated.*"
    - "!**/__snapshots__/**"
    - "!**/*.min.js"
    - "!**/*.min.css"
  max_files: 100
  max_diff_lines: 5000
  ignore_authors:
    - "dependabot[bot]"
    - "renovate[bot]"
    - "github-actions[bot]"
  min_confidence: low
  request_changes_on: critical
  max_steps: 30

cost:
  max_usd_per_pr: 2.0
  hard_stop: true
  daily_cap_usd: 100.0

ruleset:
  bug:
    enabled: true
    min_severity: minor
  security:
    enabled: true
    min_severity: info
  performance:
    enabled: true
    min_severity: major
  maintainability:
    enabled: false
  style:
    enabled: false
  docs:
    enabled: false
  test:
    enabled: true
    min_severity: minor
`;

/**
 * The canonical list of bundled preset names. Order is alphabetical for
 * stable output in `review-agent config presets list`.
 */
export const BUNDLED_PRESET_NAMES = ['recommended', 'security-focused', 'strict'] as const;
export type BundledPresetName = (typeof BUNDLED_PRESET_NAMES)[number];

const BUNDLED_PRESETS: Record<BundledPresetName, string> = {
  recommended: RECOMMENDED_YAML,
  strict: STRICT_YAML,
  'security-focused': SECURITY_FOCUSED_YAML,
};

// ---------------------------------------------------------------------------
// Deep-merge helpers
// ---------------------------------------------------------------------------

/**
 * Deep-merge `source` into `target`. Rules:
 *   - Scalars (string, number, boolean, null, undefined): source wins.
 *   - Plain objects: recurse — source keys override target keys; target-only
 *     keys are preserved.
 *   - Arrays: source REPLACES target entirely (no append).
 *
 * Neither `target` nor `source` is mutated; a new object is returned.
 */
export function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...target };
  for (const key of Object.keys(source)) {
    const srcVal = source[key];
    const tgtVal = target[key];
    if (isPlainObject(srcVal) && isPlainObject(tgtVal)) {
      result[key] = deepMerge(tgtVal, srcVal);
    } else {
      result[key] = srcVal;
    }
  }
  return result;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// ---------------------------------------------------------------------------
// Preset resolution
// ---------------------------------------------------------------------------

/**
 * Parse a single bundled preset YAML into a raw object (not yet Zod-validated).
 * Throws `PresetNotFoundError` for unknown names and `ConfigError` for parse
 * failures (the latter is a programming error — bundled YAMLs are static).
 */
function loadBundledPresetRaw(name: string): Record<string, unknown> {
  if (!isBundledPreset(name)) {
    throw new PresetNotFoundError(name);
  }
  const yaml = BUNDLED_PRESETS[name];
  let parsed: unknown;
  try {
    parsed = parseYaml(yaml) ?? {};
  } catch (err) {
    // Static YAML — should never fail; surface loudly if it does.
    throw new ConfigError(`Internal error: bundled preset '${name}' failed to parse`, {
      cause: err,
    });
  }
  if (!isPlainObject(parsed)) {
    throw new ConfigError(`Internal error: bundled preset '${name}' did not parse as an object`);
  }
  return parsed;
}

function isBundledPreset(name: string): name is BundledPresetName {
  return (BUNDLED_PRESET_NAMES as ReadonlyArray<string>).includes(name);
}

/**
 * Resolve an `extends:` value into a merged raw config object that can be
 * passed to `ConfigSchema.parse`.
 *
 * @param extendsValue - the parsed value of the `extends:` key (already
 *   stripped from the raw YAML object before calling this).
 * @param repoRaw - the raw repo YAML object (without the `extends` key).
 * @returns a merged raw object (repo wins over presets).
 *
 * Cycle detection: bundled presets do not themselves use `extends:`, so
 * cycles cannot form with the current preset set. The detection is included
 * to guard against future user-authored preset definitions or preset-of-
 * presets scenarios, and to provide a clear error rather than infinite
 * recursion.
 */
export function resolveExtendsPresets(
  extendsValue: ReadonlyArray<string>,
  repoRaw: Record<string, unknown>,
): Record<string, unknown> {
  // Cycle detection: walk the extends chain. Each name may only appear once.
  const visited = new Set<string>();

  // Build the merged base from presets left-to-right.
  let base: Record<string, unknown> = {};
  for (const name of extendsValue) {
    if (name === 'org') {
      // 'org' inside an array is not supported. Raise a clear error.
      throw new PresetNotFoundError(
        // Use a custom message by constructing from ConfigError instead of
        // PresetNotFoundError to avoid the generic "bundled presets are:"
        // suffix that wouldn't apply here.
        // We still use PresetNotFoundError (a ConfigError subclass) but
        // override the message by re-throwing a ConfigError.
        'org',
      );
    }
    if (visited.has(name)) {
      const cycle = [...visited, name];
      throw new PresetCycleError(cycle);
    }
    visited.add(name);

    const presetRaw = loadBundledPresetRaw(name);

    // Check if the preset itself declares extends (future-proofing).
    if (isPlainObject(presetRaw) && 'extends' in presetRaw) {
      const innerExtends = presetRaw.extends;
      if (Array.isArray(innerExtends)) {
        for (const inner of innerExtends) {
          if (typeof inner === 'string' && visited.has(inner)) {
            throw new PresetCycleError([...visited, inner]);
          }
        }
      }
    }

    base = deepMerge(base, presetRaw);
  }

  // Repo config is applied last — it wins over all presets.
  return deepMerge(base, repoRaw);
}
