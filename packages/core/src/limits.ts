/**
 * Centralised numeric limits and budgets. This module is the
 * **source of truth** for every operator-facing cap referenced by
 * `core/schemas.ts`, `runner/auto-fetch.ts`, and `runner/tools.ts`.
 * Callers in `runner` import from `@review-agent/core` — `core` itself
 * never imports back from `runner` (which would invert the package
 * dependency direction).
 *
 * Why centralise: each constant here is referenced by either a Zod
 * schema, a runner-side enforcement check, or both, and the spec
 * (review-agent §13, §15) calls out the numeric values verbatim.
 * Audit and operator-tuning conversations want one place to look,
 * not three.
 *
 * What does NOT belong here: numbers that are private implementation
 * details of a single module (retry backoff timings, internal map
 * capacities, etc.) stay co-located with the code that uses them.
 * Adding here only when the value crosses a package boundary or is
 * referenced by a spec section.
 */

// --- ReviewOutput / ReviewState schema caps (spec §13 InlineComment) ---

/** Maximum byte length of a file path emitted by the LLM. */
export const PATH_MAX = 500;

/** Maximum length of an inline comment body. */
export const BODY_MAX = 5_000;

/** Maximum length of a suggested replacement block. */
export const SUGGESTION_MAX = 5_000;

/** Maximum length of the top-level review summary. */
export const SUMMARY_MAX = 10_000;

/** Maximum 1-based line number accepted on an inline comment. */
export const LINE_MAX = 1_000_000;

/** Maximum number of inline comments in a single ReviewOutput. */
export const COMMENTS_MAX = 50;

/** Inclusive bounds on `modelUsed` string length in ReviewState. */
export const MODEL_NAME_MIN = 1;
export const MODEL_NAME_MAX = 128;

/** Inclusive bounds on `ruleId` string length. */
export const RULE_ID_MIN = 2;
export const RULE_ID_MAX = 64;

// --- Runner workspace tools (spec §15 read_file / grep) ---

/**
 * Hard cap on the bytes `read_file` returns to the LLM. Content past
 * this point is truncated with a `[...truncated at N chars]` marker
 * so the LLM context window stays bounded for very large files
 * (lockfiles, snapshot fixtures, generated code). Mirrored by a
 * runner-side check; this constant is the canonical value.
 */
export const MAX_FILE_SIZE = 1_000_000;

/**
 * ReDoS guard: the longest user-supplied regex the `grep` tool
 * accepts. Pathological patterns (e.g. `(a?){100}a{100}`) explode
 * exponentially on regex backtracking, so we reject anything
 * substantially longer than reasonable code-search needs.
 */
export const MAX_GREP_PATTERN_LENGTH = 200;

// --- Auto-fetch budget (spec §15 path_instructions.auto_fetch) ---

/** Maximum number of companion files auto-fetched per review. */
export const AUTO_FETCH_MAX_FILES = 5;

/** Maximum bytes read per auto-fetched file. */
export const AUTO_FETCH_MAX_BYTES_PER_FILE = 50_000;

/** Maximum total bytes across all auto-fetched files in one review. */
export const AUTO_FETCH_MAX_TOTAL_BYTES = 250_000;
